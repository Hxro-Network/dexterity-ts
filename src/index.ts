import untyped_dex_idl from './dex.json';
import untyped_instruments_idl from './instruments.json';
import untyped_risk_idl from './risk.json';

import BN from 'bn.js';
BN.prototype.toJSON = function () { return BN.prototype.toString.call(this, 10) };
import { serialize } from 'borsh';
const WebSocketWtf = require('isomorphic-ws');
const WebSocket = WebSocketWtf.default;
global.Buffer = global.Buffer || require('buffer').Buffer;

import { Idl, Program, AnchorProvider, Wallet, web3 } from '@coral-xyz/anchor';
import {
    createAssociatedTokenAccount, createAssociatedTokenAccountInstruction, getAssociatedTokenAddress,
    getAccount, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { EventFill, EventOut, EventQueue, EventQueueHeader, MarketState, Slab, LeafNode } from '@bonfida/aaob';

Object.defineProperty(EventQueueHeader, 'LEN', {
    configurable: true,
    writable: true,
    value: 33
});
//ADDED WALLET IMPLEMENTATION
export type DexterityWallet = {
    publicKey: web3.PublicKey,
    signTransaction: <T extends web3.Transaction | web3.VersionedTransaction>(transaction: T) => Promise<T>,
    signAllTransactions: <T extends web3.Transaction | web3.VersionedTransaction>(transactions: T[]) => Promise<T[]>
}

const DEX_ID = new web3.PublicKey('FUfpR31LmcP1VSbz5zDaM7nxnH55iBHkpwusgrnhaFjL');
const INSTRUMENTS_ID = new web3.PublicKey('8981bZYszfz1FrFVx7gcUm61RfawMoAHnURuERRJKdkq');
const RISK_ID = new web3.PublicKey('92wdgEqyiDKrcbFHoBTg8HxMj932xweRCKaciGSW3uMr');
const STAKING_ID = new web3.PublicKey("2jmux3fWV5zHirkEZCoSMEgTgdYZqkE9Qx2oQnxoHRgA");

// @ts-ignore
const DEX_IDL: Idl = untyped_dex_idl;
// @ts-ignore
const INSTRUMENTS_IDL: Idl = untyped_instruments_idl;
// @ts-ignore
const RISK_IDL: Idl = untyped_risk_idl;

const SENTINEL = 0;
const UNINITIALIZED = '11111111111111111111111111111111';
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const MPG_SIZE = 143960;
const TRG_SIZE = 13272;
const MAX_OUTRIGHTS = 128;

const MAX_COMPUTE_UNITS = 1400000; // 1.4m is solana's max
const MAX_CANCELS_PER_TX = 10;

const ORACLE_TYPE_PYTH = 1;
const INSTRUMENT_TYPE_RECURRING_CALL = 1;
const INSTRUMENT_TYPE_EXPIRING_CALL = 2;

let rpc2manifest = new Map(); // maps rpc url to manifest (AAOB, DEX, FEES, RISK, MPGs, products, orderbooks, etc.)
let account2WebSocket = new Map(); // maps rpc:account to websocket

enum OrderType {
    Limit,
    ImmediateOrCancel,
    FillOrKill,
    PostOnly,
}

interface Product {
    combo,
    outright,
}

export interface MarketProductGroup {
    feeModelProgramId: web3.PublicKey;
    feeModelConfigurationAcct: web3.PublicKey;
    feeOutputRegister: web3.PublicKey;
    riskEngineProgramId: web3.PublicKey;
    riskModelConfigurationAcct: web3.PublicKey;
    riskOutputRegister: web3.PublicKey;
    vaultMint: web3.PublicKey;
    addressLookupTable: web3.PublicKey;

    marketProducts: { array: Array<Product> }
}

export interface TraderRiskGroup {
    feeStateAccount: web3.PublicKey;
    marketProductGroup: web3.PublicKey;
    owner: web3.PublicKey;
    riskStateAccount: web3.PublicKey;

    openOrders: {
        maxOpenOrders: BN;
        products: Array<{
            headIndex: BN;
        }>;
        orders: Array<{
            id: BN;
            qty: BN;
            next: BN;
            prev: BN;
        }>;
    }
    traderPositions: Array<{
        tag: Object;
        productIndex: number;
        productKey: web3.PublicKey;
        position: SimpleFractional;
    }>;

    cashBalance: SimpleFractional;
    pendingCashBalance: SimpleFractional;
    totalWithdrawn: SimpleFractional;
    totalDeposited: SimpleFractional;
    notionalMakerVolume: SimpleFractional;
    notionalTakerVolume: SimpleFractional;
    referredTakersNotionalVolume: SimpleFractional;
    referralFees: SimpleFractional;
}

interface I128 {
    value: BN
}

export interface MarkPrice {
    productKey: web3.PublicKey;
    markPrice: I128;
    prevOracleMinusBookEwma: I128;
    oracleMinusBookEwma: I128;
}

export interface MarkPricesArray {
    isHardcodedOracle: boolean;
    hardcodedOracle: web3.PublicKey;
    array: Array<MarkPrice>;
}

interface DerivativeMetadata {
    priceOracle: web3.PublicKey;
    instrumentType: number;
    oracleType: number;
    // TODO
}

type SimpleFractional = {
    m: BN;
    exp: BN;
};

const bnSqrt = (num: BN): BN => {
  if(num.lt(new BN(0))) {
    throw new Error("Sqrt only works on non-negtiave inputs")
  }
  if(num.lt(new BN(2))) {
    return num
  }

  const smallCand = bnSqrt(num.shrn(2)).shln(1)
  const largeCand = smallCand.add(new BN(1))

  if (largeCand.mul(largeCand).gt(num)) {
    return smallCand
  } else {
    return largeCand
  }
}

class ReliableWebSocket {
    socket: WebSocket;
    isClosed: boolean;
    ref: number = 1;
    eventQueueSeqNum: number = 0;

    constructor(socket: WebSocket) {
        this.socket = socket;
        this.isClosed = false;
    }
    close() {
        if (--this.ref == 0) {
          this.isClosed = true;
          this.socket.close();
        }
    }
    addRef() {
        this.ref++;
        return this;
    }
}

function toWebSocket(httpEndpoint) {
    return httpEndpoint.replace('https://', 'wss://')
        .replace('http://', 'ws://')
        .replace('127.0.0.1:8899', '127.0.0.1:8900')
        .replace('::1:8899', '::1:8900')
        .replace('localhost:8899', 'localhost:8900');
}

export type ManifestFields = {
    rpc: string;
    wallet: DexterityWallet | Wallet;
    connection: web3.Connection;
    dexProgram: Program;
    instrumentsProgram: Program;
    riskProgram: Program;
    aaob_id: web3.PublicKey;
    dex_id: web3.PublicKey;
    mpgs: Map<string, { pubkey: web3.PublicKey, mpg: MarketProductGroup, orderbooks: Map<string, MarketState>, covarianceMetadata: CovarianceMetadata }>;
    creationTime: number;
};

export class Order {
    id: BN;
    productName: string;
    productIndex: number;
    price: Fractional;
    qty: Fractional;
    isBid: boolean;

    constructor(id: BN, productName: string, productIndex: number, price: Fractional, qty: Fractional, isBid: boolean) {
        this.id = id;
        this.productName = productName;
        this.productIndex = productIndex;
        this.price = price;
        this.qty = qty;
        this.isBid = isBid;
    }
}

type ApiFill = {
    tx_sig: string;
    product: string;
    block_timestamp: Date;
    slot: number;
    inserted_at: Date;
    taker_side: string;
    mpg: string;
    maker_order_id: number;
    quote_size: number;
    base_size: number;
    maker_trg: string;
    taker_trg: string;
}

type GetFillsResponse = {
    fills: ApiFill[];
};


export class Manifest {
    // we do this so we don't duplicate the type specification
    fields: ManifestFields;
    base_api_url: string;
    slot: number;
    timestamp: Date;
    rws: ReliableWebSocket;
    accountSubscribeId: number;
    pk2SubscriptionId: Map<string, number>;
    wsId2SubscriptionId: Map<number, number>;
    pk2LastUpdateTimestamp: Map<number, number>;
    websocketHeartbeatPeriodMs: number;

    constructor(fields: ManifestFields) {
        this.fields = fields;
        if (this.fields.rpc.toLowerCase().includes("devnet")) {
            this.base_api_url = "http://theo-publi-v73qtzqb8eja-694197461.eu-west-2.elb.amazonaws.com/";
        } else {
            this.base_api_url = "https://dexterity.hxro.com/";
        }
        this.rws = null;
        this.accountSubscribeId = 1;
        this.websocketHeartbeatPeriodMs = 5000;
    }

    setWallet(wallet) {
        const confirmOptions: web3.ConfirmOptions = { preflightCommitment: 'processed' };
        const connection = new web3.Connection(this.fields.rpc, confirmOptions.preflightCommitment);
        const provider = new AnchorProvider(connection, wallet, confirmOptions);
        let dexProgram = createDexProgram(provider);
        let instrumentsProgram = createInstrumentsProgram(provider);
        let riskProgram = createRiskProgram(provider);
        this.fields.dexProgram = dexProgram;
        this.fields.instrumentsProgram = instrumentsProgram;
        this.fields.riskProgram = riskProgram;
        this.fields.wallet = wallet;
    }

    static GetRiskAndFeeSigner(mpg: web3.PublicKey): web3.PublicKey {
        return web3.PublicKey.findProgramAddressSync([mpg.toBuffer()], new web3.PublicKey(DEX_ID))[0]
    }

    static GetStakePool(): web3.PublicKey {
        return new web3.PublicKey("9zdpqAgENj4734TQvqjczMg2ekvvuGsxwJC6f7F1QWp4");
    }

    getRiskS(marketProductGroup: web3.PublicKey, mpg): web3.PublicKey {
        return web3.PublicKey.findProgramAddressSync([Buffer.from("s", "utf-8"), marketProductGroup.toBuffer()], new web3.PublicKey(mpg.riskEngineProgramId))[0];
    }

    getRiskR(marketProductGroup: web3.PublicKey, mpg): web3.PublicKey {
        return web3.PublicKey.findProgramAddressSync([Buffer.from("r", "utf-8"), marketProductGroup.toBuffer()], new web3.PublicKey(mpg.riskEngineProgramId))[0];
    }

    static async GetATAFromMPGObject(mpg: MarketProductGroup, wallet: web3.PublicKey) {
        return await getAssociatedTokenAddress(
            mpg.vaultMint,
            wallet
        );
    }

    primeWebsocket(pk, parseDataFn, onUpdateFn) {
        if (this.rws === null) {
            let socket = new WebSocket(toWebSocket(this.fields.rpc));
            socket.addEventListener('error', (async event => {
                // console.log(event);
                // console.error(`websocket for ${pkStr} saw error event ${event}`);
            }));
            socket.addEventListener('close', async _ => {
                this.accountSubscribe(pk, parseDataFn, onUpdateFn);
                // console.debug('server closed the websocket to', pkStr, 'so we re-opened it');
            });
            this.rws = new ReliableWebSocket(socket);
            socket.addEventListener('open', _ => {});
            this.wsId2SubscriptionId = new Map();
            this.pk2SubscriptionId = new Map();
            this.pk2LastUpdateTimestamp = new Map();

        }
        return this.rws;
    }

    getAccountSubscribeId() {
        const id = this.accountSubscribeId;
        this.accountSubscribeId += 1;
        return id;
    }

    accountSubscribe(pk, parseDataFn, onUpdateFn) {
        this.primeWebsocket(pk, parseDataFn, onUpdateFn);
        const wsId = this.getAccountSubscribeId();
        const pkStr = pk.toBase58();
        const subscriptionId = this.pk2SubscriptionId.get(pkStr);
        const sendSubscribe = typeof subscriptionId !== undefined;
        if (sendSubscribe) {
            this.wsId2SubscriptionId.set(wsId, subscriptionId);
        }
        this.rws.socket.addEventListener('message', (async event => {
            const msg = JSON.parse(event.data);
            if (typeof msg.result === 'number') {
                // initial PONG gives {"jsonrpc": "2.0","result":<SOME NUMBER>,"id":1}
                if (msg.id === wsId) {
                    this.wsId2SubscriptionId.set(wsId, msg.result);
                    this.pk2SubscriptionId.set(pkStr, msg.result);
                    this.pk2LastUpdateTimestamp.set(pkStr, Date.now());
                    let heartbeatId = setInterval(() => {
                        const now = Date.now();
                        const lastUpdate = this.pk2LastUpdateTimestamp.get(pkStr);
                        if (now - lastUpdate > this.websocketHeartbeatPeriodMs) {
                            // console.log('havent seen update for', pkStr, 'for', this.websocketHeartbeatPeriodMs, 'ms so sending unsubscribe and re-subscribing');
                            clearInterval(heartbeatId);
                            this.rws.socket.send(JSON.stringify({
                                'jsonrpc': '2.0',
                                'id': msg.result,
                                'method': 'accountUnsubscribe',
                                'params': [
                                    pkStr,
                                    {
                                        'encoding': 'base64',
                                        'commitment': 'processed'
                                    }
                                ]
                            }));
                            this.rws.socket.send(JSON.stringify({
                                'jsonrpc': '2.0',
                                'id': wsId,
                                'method': 'accountSubscribe',
                                'params': [
                                    pkStr,
                                    {
                                        'encoding': 'base64',
                                        'commitment': 'processed'
                                    }
                                ]
                            }));
                        }
                    }, this.websocketHeartbeatPeriodMs);
                }
                return;
            }
            if (msg.params?.subscription && msg.params.subscription === this.wsId2SubscriptionId.get(wsId)) {
                // msg.params?.subscription
                // that expression is needed because when we send accountUnsubscribe, the response doesn't have .subscription ^^^
                // console.log('saw update for', pkStr);
                this.pk2LastUpdateTimestamp.set(pkStr, Date.now());
                onUpdateFn(await parseDataFn(Buffer.from(msg.params.result.value.data[0], 'base64'), this), msg.params.result.context.slot);
            }
        }).bind(this));
        if (sendSubscribe) {
            if (this.rws.socket.readyState === 1) {
                this.rws.socket.send(JSON.stringify({
                    'jsonrpc': '2.0',
                    'id': wsId,
                    'method': 'accountSubscribe',
                    'params': [
                        pkStr,
                        {
                            'encoding': 'base64',
                            'commitment': 'processed'
                        }
                    ]
                }));
            } else {
                this.rws.socket.addEventListener('open', (async event => {
                    this.rws.socket.send(JSON.stringify({
                        'jsonrpc': '2.0',
                        'id': wsId,
                        'method': 'accountSubscribe',
                        'params': [
                            pkStr,
                            {
                                'encoding': 'base64',
                                'commitment': 'processed'
                            }
                        ]
                    }));
                }));
            }
        }
        // @ts-ignore
        this.rws.getSnapshot = (async () => {
            // specifically commented out because now everything flows through the same, single rws object
            // so getSnapshot doesn't make sense.
            // const accinfo = await this.fields.connection.getAccountInfo(pk);
            // onUpdateFn(await parseDataFn(accinfo.data, this));
        }).bind(this);
        // @ts-ignore
        // rws.getSnapshot();
        const getSnapshot = (async () => {
            const accinfo = await this.fields.connection.getAccountInfo(pk);
            this.pk2LastUpdateTimestamp.set(pkStr, Date.now());
            onUpdateFn(await parseDataFn(accinfo.data, this));
        });
        getSnapshot();
        return this.rws;
    }

    static EventQueueFromData(data, marketState) {
        return EventQueue.parse(marketState.callBackInfoLen, data);
    }

    static FillsFromEventQueue(eventQueue, meta) {
        const offsetFrac = Fractional.From(meta.priceOffset);
        const tickSize = Fractional.From(meta.tickSize);
        const count = eventQueue.header.count.toNumber();
        const fills = [];
        for (let i = 0; i < count; i++) {
            const event = eventQueue.parseEvent(i);
            if (event instanceof EventFill) {
                const fill = event;
                const baseQty = Fractional.New(fill.baseSize, meta.baseDecimals);
                // TODO idk why typescript doesn't believe "EventFill | EventOut" has the field "quoteSize"
                // @ts-ignore
                const quoteQty = Fractional.New(fill.quoteSize, meta.baseDecimals);
                // there is a bug in the version of @bonfida/aaob that we use. We have to hack the callbackinfo parsing like so:
                const makerCallbackInfo = fill.makerCallbackInfo.slice(0, fill.makerCallbackInfo.length / 2);
                const takerCallbackInfo = fill.makerCallbackInfo.slice(fill.makerCallbackInfo.length / 2);
                fills.push({
                    price: quoteQty.div(baseQty).mul(tickSize).sub(offsetFrac),
                    quantity: baseQty,
                    // TODO idk why typescript doesn't believe "EventFill | EventOut" has the field "takerSide"
                    // @ts-ignore
                    isBidAgressor: fill.takerSide === 0,
                    maker: new web3.PublicKey(makerCallbackInfo.slice(0, 32)),
                    taker: new web3.PublicKey(takerCallbackInfo.slice(0, 32)),
                    makerOrderId: fill.makerOrderId,
                    takerOrderNonce: new BN(takerCallbackInfo.slice(40, 56), undefined, 'le'),
                    takerClientOrderId: new BN(takerCallbackInfo.slice(takerCallbackInfo.length - 8), undefined, 'le'),
                    makerClientOrderId: new BN(makerCallbackInfo.slice(makerCallbackInfo.length - 8), undefined, 'le'),
                });
            }
        }
        return fills;
    }

    static OutsFromEventQueue(eventQueue, meta) {
        const offsetFrac = Fractional.From(meta.priceOffset);
        const tickSize = Fractional.From(meta.tickSize);
        const count = eventQueue.header.count.toNumber();
        const outs = [];
        for (let i = 0; i < count; i++) {
            const event = eventQueue.parseEvent(i);
            if (event instanceof EventOut) {
                const baseQty = Fractional.New(event.baseSize, meta.baseDecimals);
                outs.push({
                    quantity: baseQty,
                    orderId: event.orderId,
                    maker: new web3.PublicKey(event.callBackInfo.slice(0, 32)),
                    openOrdersIndex: new BN(event.callBackInfo.slice(32, 40), undefined, 'le'),
                    clientOrderId: new BN(event.callBackInfo.slice(event.callBackInfo.length - 8), undefined, 'le'),
                    isBid: event.side === 0,
                });
            }
        }
        return outs;
    }

    static GetFundingRate(markPrices: MarkPricesArray, productKey: web3.PublicKey, mfp = null, ffp = null, mpg = null): Fractional {
        const markPrice = Manifest.GetMarkPrice(markPrices, productKey, mpg);
        const indexPrice = Manifest.GetIndexPrice(markPrices, productKey, mpg);
        if (mfp == null) {
            mfp = Fractional.New(1, 0);
        }
        if (ffp == null) {
            ffp = Fractional.New(24, 0);
        }
        return (markPrice.sub(indexPrice)).div(indexPrice).mul(mfp).div(ffp);
    }

    static GetMarkPrice(markPrices: MarkPricesArray, productKey: web3.PublicKey, mpg: MarketProductGroup = null): Fractional {
        for (const mp of markPrices.array) {
            if (mp.productKey.equals(productKey)) { // idk how equality works with solana web3.PublicKey
                return Manifest.FromFastInt(mp.markPrice.value);
            }
        }
        // assume it's a combo
        const combo = Manifest.GetProductOfMpg(mpg, productKey)?.combo?.combo;
        if (!combo) {
            return Fractional.Nan();
        }
        let markPrice = Fractional.Zero();
        const numLegs = combo.numLegs.toNumber();
        for (let i = 0; i < numLegs; i++) {
            const leg = combo.legs[i];
            markPrice = markPrice.add(Fractional.New(leg.ratio.toNumber(), 0).mul(Manifest.GetMarkPrice(markPrices, leg.productKey)));
        }
        return markPrice;
    }

    static GetMarkPriceOracleMinusBookEwma(markPrices: MarkPricesArray, productKey: web3.PublicKey, mpg: MarketProductGroup = null): Fractional {
        for (const mp of markPrices.array) {
            if (mp.productKey.equals(productKey)) { // idk how equality works with solana web3.PublicKey
                return Manifest.FromFastInt(mp.oracleMinusBookEwma.value);
            }
        }
        // assume it's a combo
        const combo = Manifest.GetProductOfMpg(mpg, productKey)?.combo?.combo;
        if (!combo) {
            return Fractional.Nan();
        }
        let spread = Fractional.Zero();
        const numLegs = combo.numLegs.toNumber();
        for (let i = 0; i < numLegs; i++) {
            const leg = combo.legs[i];
            spread = spread.add(Fractional.New(leg.ratio.toNumber(), 0).mul(Manifest.GetMarkPriceOracleMinusBookEwma(markPrices, leg.productKey)));
        }
        return spread;
    }

    static GetIndexPrice(markPrices: MarkPricesArray, productKey: web3.PublicKey, mpg: MarketProductGroup = null): Fractional {
        const markPrice = Manifest.GetMarkPrice(markPrices, productKey, mpg);
        const priceOracleMinusBookEwma = Manifest.GetMarkPriceOracleMinusBookEwma(markPrices, productKey, mpg);
        if (!markPrice.isNan() && !priceOracleMinusBookEwma.isNan()) {
            return markPrice.add(priceOracleMinusBookEwma);
        }
        // assume it's a combo
        const combo = Manifest.GetProductOfMpg(mpg, productKey)?.combo?.combo;
        if (!combo) {
            return Fractional.Nan();
        }
        let indexPrice = Fractional.Zero();
        const numLegs = combo.numLegs.toNumber();
        for (let i = 0; i < numLegs; i++) {
            const leg = combo.legs[i];
            indexPrice = indexPrice.add(Fractional.New(leg.ratio.toNumber(), 0).mul(Manifest.GetIndexPrice(markPrices, leg.productKey)));
        }
        return indexPrice;
    }

    static GetMidpointPrice(mpg: MarketProductGroup, productKey: web3.PublicKey): Fractional {
        const product = Manifest.GetProductOfMpg(mpg, productKey);
        if (!product) {
            return Fractional.Nan();
        }
        const meta = productToMeta(product);
        const ask = Fractional.From(meta.prices.ask);
        const bid = Fractional.From(meta.prices.bid);
        const book = ask.add(bid).div(Fractional.New(2, 0));
        const isAskValid = !(ask.m.eq(MAX_ASK) && ask.exp.eq(ZERO_BN));
        const isBidValid = !(bid.m.eq(MIN_BID) && bid.exp.eq(ZERO_BN));
        if (isAskValid && isBidValid) {
            return book;
        } else if (isAskValid) {
            return ask;
        } else if (isBidValid) {
            return bid;
        }
        return Fractional.Nan();
    }

    static FromFastInt(bn: BN): Fractional {
        return new Fractional(bn, new BN(6));
    }

    async getMPGFromData(data): Promise<MarketProductGroup> {
        // @ts-ignore
        return await Manifest.GetMPGFromData(this.fields.dexProgram, data);
    }

    static async GetMPGFromData(dexProgram: Program, data): Promise<MarketProductGroup> {
        if (data.length > MPG_SIZE) {
            data = data.slice(0, MPG_SIZE);
        } else if (data.length < MPG_SIZE) {
            const newData = new Uint8Array(MPG_SIZE);
            newData.set(data);
            data = Buffer.from(newData);
        }
        // @ts-ignore
        return await dexProgram.account.paddedMarketProductGroup._coder.accounts.decodeUnchecked('PaddedMarketProductGroup', data);
    }

    async getMPG(mpg: web3.PublicKey): Promise<MarketProductGroup> {
        const mpgAccInfo = await this.fields.dexProgram.account.paddedMarketProductGroup.getAccountInfo(mpg);
        return await this.getMPGFromData(mpgAccInfo.data);
    }

    static GetProductsOfMPG(mpg: MarketProductGroup) {
        let m = new Map();
        let i = -1;
        for (const p of mpg.marketProducts.array) {
            i++;
            if (productStatus(p, mpg.marketProducts.array) === 'uninitialized') {
                continue;
            }
            m.set(bytesToString(productToMeta(p).name), { index: i, product: p });
        }
        return m;
    }

    static GetProductOfMpg(mpg: MarketProductGroup, productKey: web3.PublicKey) {
        let product;
        for (const p of mpg.marketProducts.array) {
            if (productStatus(p, mpg.marketProducts.array) !== 'initialized') {
                continue;
            }
            if (productToMeta(p).productKey.equals(productKey)) {
                return p;
            }
        }
    }

    static GetActiveProductsOfMPG(mpg: MarketProductGroup) {
        let m = new Map();
        let i = -1;
        for (const p of mpg.marketProducts.array) {
            i++;
            if (productStatus(p, mpg.marketProducts.array) !== 'initialized') {
                continue;
            }
            m.set(bytesToString(productToMeta(p).name), { index: i, product: p });
        }
        return m;
    }

    static GetProductIndex(mpg: MarketProductGroup, productKey: web3.PublicKey) {
        let m = new Map();
        let i = -1;
        for (const p of mpg.marketProducts.array) {
            i++;
            const meta = productToMeta(p);
            if (meta.productKey.equals(productKey)) {
                return i;
            }
        }
        return null;
    }

    async getDerivativeMetadataFromData(data): Promise<DerivativeMetadata> {
        // @ts-ignore
        return await Manifest.GetDerivativeMetadataFromData(this.fields.instrumentsProgram, data);
    }

    static async GetDerivativeMetadataFromData(instrumentsProgram: Program, data): Promise<DerivativeMetadata> {
        // @ts-ignore
        return await instrumentsProgram.account.paddedDerivativeMetadata._coder.accounts.decodeUnchecked('PaddedDerivativeMetadata', data);
    }

    async getDerivativeMetadata(productKey: web3.PublicKey): Promise<DerivativeMetadata> {
        const dmAccInfo = await this.fields.instrumentsProgram.account.paddedDerivativeMetadata.getAccountInfo(productKey);
        return await this.getDerivativeMetadataFromData(dmAccInfo.data);
    }

    async getTRGFromData(data): Promise<TraderRiskGroup> {
        if (data.length < TRG_SIZE) {
            const newData = new Uint8Array(TRG_SIZE);
            newData.set(data);
            data = Buffer.from(newData);
        }
        // @ts-ignore
        let trg = await this.fields.dexProgram.account.paddedTraderRiskGroup._coder.accounts.decodeUnchecked('PaddedTraderRiskGroup', data);
        let max_open_orders = trg.openOrders.maxOpenOrders;
        // @ts-ignore
        let accountLayout = this.fields.dexProgram.account.paddedTraderRiskGroup._coder.accounts.accountLayouts.get('PaddedTraderRiskGroup');
        let struct = accountLayout.fields[accountLayout.fields.length - 1];
        struct.fields[5].span = max_open_orders * 40;
        struct.fields[5].layout.fields[0].span = max_open_orders * 40;
        struct.fields[5].layout.fields[0].count = max_open_orders;
        // @ts-ignore
        return await this.fields.dexProgram.account.paddedTraderRiskGroup._coder.accounts.decodeUnchecked('PaddedTraderRiskGroup', data);
    }

    async getTRG(trg: web3.PublicKey): Promise<TraderRiskGroup> {
        let accinfo = await this.fields.dexProgram.account.paddedTraderRiskGroup.getAccountInfo(trg);
        return await this.getTRGFromData(accinfo.data);
    }

    getMarkPricesAccount(marketProductGroup: web3.PublicKey, mpg): web3.PublicKey {
        return web3.PublicKey.findProgramAddressSync([Buffer.from("mark_prices", "utf-8"), marketProductGroup.toBuffer()], new web3.PublicKey(mpg.riskEngineProgramId))[0];
    }

    async getMarkPricesFromData(data): Promise<MarkPricesArray> {
        // @ts-ignore
        return await this.fields.riskProgram.account.paddedMarkPricesArray._coder.accounts.decodeUnchecked('PaddedMarkPricesArray', data);
    }

    async getMarkPrices(markPricesAccount: web3.PublicKey): Promise<MarkPricesArray> {
        let accinfo = await this.fields.riskProgram.account.paddedMarkPricesArray.getAccountInfo(markPricesAccount);
        return await this.getMarkPricesFromData(accinfo.data);
    }

    async getVarianceCache(varianceCache: web3.PublicKey): Promise<VarianceCache> {
        const accinfo = await this.fields.connection.getAccountInfo(varianceCache);
        return accinfo.data;
    }

    async getCovarianceMetadata(marketProductGroup: web3.PublicKey, mpg): Promise<CovarianceMetadata> {
        const accinfo = await this.fields.connection.getAccountInfo(this.getRiskS(marketProductGroup, mpg));
        return accinfo.data;
    }

    async getBook(product, marketState) {
        const offset = Fractional.From(product.metadata.priceOffset);
        const tickSize = Fractional.From(product.metadata.tickSize);
        const baseDecimals = product.metadata.baseDecimals;
        const bidsSlab = await marketState.loadBidsSlab(this.fields.connection, "processed");
        const bids = [];
        for (const order of bidsSlab.items(true)) {
            bids.push({
                quantity: new Fractional(order.baseQuantity, baseDecimals),
                price: Manifest.aaobOrderToDexPrice(order, tickSize, offset),
                info: bidsSlab.getCallBackInfo(order.callBackInfoPt),
                key: order.key.toString(),
            })
        }
        const asksSlab = await marketState.loadAsksSlab(this.fields.connection, "processed");
        const asks = [];
        for (const order of asksSlab.items(true)) {
            asks.push({
                quantity: new Fractional(order.baseQuantity, baseDecimals),
                price: Manifest.aaobOrderToDexPrice(order, tickSize, offset),
                info: asksSlab.getCallBackInfo(order.callBackInfoPt),
                key: order.key.toString(),
            })
        }
        return {
            bids,
            asks
        }
    }

    static aaobOrderToDexPrice(aaobOrder: LeafNode, tickSize: Fractional, offset: Fractional): Fractional {
        return new Fractional(aaobOrder.getPrice().shrn(32), new BN(0)).mul(tickSize).sub(offset);
    }

    static orderIdToDexPrice(id: BN, tickSize: Fractional, offset: Fractional): Fractional {
        return new Fractional(id.shrn(64 + 32), new BN(0)).mul(tickSize).sub(offset);
    }

    static orderIdIsBid(id: BN): boolean {
        return (id.shrn(63) & 1) != 0;
    }

    streamBooks(product, marketState, onBookFn, onMarkPricesFn = null): { asksSocket: ReliableWebSocket, bidsSocket: ReliableWebSocket, markPricesSocket: ReliableWebSocket } {
        const offset = Fractional.From(product.metadata.priceOffset);
        const tickSize = Fractional.From(product.metadata.tickSize);
        const baseDecimals = product.metadata.baseDecimals;
        let [bids, asks] = [[], []];
        const bidsSocket = this.accountSubscribe(marketState.bids,
            async (data, manifest) => {
                bids = [];
                const slab = Slab.deserialize(data, marketState.callBackInfoLen);
                for (const order of slab.items(true)) {
                    bids.push({
                        quantity: new Fractional(order.baseQuantity, baseDecimals),
                        price: Manifest.aaobOrderToDexPrice(order, tickSize, offset),
                        info: slab.getCallBackInfo(order.callBackInfoPt),
                        key: order.key.toString(),
                    });
                }
                return {
                    bids,
                    asks
                };
            },
            onBookFn,
        );
        const asksSocket = this.accountSubscribe(
            marketState.asks,
            async (data, manifest) => {
                asks = [];
                const slab = Slab.deserialize(data, marketState.callBackInfoLen);
                for (const order of slab.items(true)) {
                    asks.push({
                        quantity: new Fractional(order.baseQuantity, baseDecimals),
                        price: Manifest.aaobOrderToDexPrice(order, tickSize, offset),
                        info: slab.getCallBackInfo(order.callBackInfoPt),
                        key: order.key.toString(),
                    });
                }
                return {
                    bids,
                    asks
                };
            },
            onBookFn,
        );
        let markPricesSocket = null;
        if (onMarkPricesFn !== null) {
            const productPk = product.metadata.productKey.toString();
            let mpgPk = null;
            let desiredMpg = null;
            for (const [pk, { pubkey, mpg }] of this.fields.mpgs) {
                for (let [productName, { index, product }] of Manifest.GetProductsOfMPG(mpg)) {
                    const meta = productToMeta(product);
                    if (meta.productKey.toString() === productPk) {
                        mpgPk = pubkey;
                        desiredMpg = mpg;
                        break;
                    }
                }
                if (mpgPk !== null) {
                    break;
                }
            }
            if (mpgPk === null) {
                throw new Error('failed to find mpg associated to the product ' + productPk);
            }
            markPricesSocket = this.accountSubscribe(
                this.getMarkPricesAccount(mpgPk, desiredMpg),
                async (data, manifest) => { return await this.getMarkPricesFromData(data); },
                onMarkPricesFn,
            );
        }
        return { asksSocket, bidsSocket, markPricesSocket };
    }

    streamTrades(product, marketState, onTradesFn): ReliableWebSocket {
        let eventQueueSeqNum = 0;
        const socket = this.accountSubscribe(
            marketState.eventQueue,
            async (data, manifest) => {
                const eventQueue = Manifest.EventQueueFromData(data, marketState);
                const seqNum = eventQueue.header.seqNum.toNumber();
                if (seqNum <= eventQueueSeqNum) { return []; }
                eventQueueSeqNum = seqNum;
                return Manifest.FillsFromEventQueue(eventQueue, product.metadata);
            },
            onTradesFn,
        );
        return socket;
    }

    streamMPG(mpg: web3.PublicKey, onUpdateFn): ReliableWebSocket {
        return this.accountSubscribe(
            mpg,
            (async (data, manifest) => await this.getMPGFromData(data)).bind(this),
            onUpdateFn,
        );
    }

    async getOracle(product): Promise<web3.PublicKey> {
        const dm = await this.getDerivativeMetadata(product);
        return dm.priceOracle;
    }

    async streamPythPrice(product, onUpdateFn): Promise<ReliableWebSocket> {
        return this.streamPythPriceFromPubkey(await this.getOracle(product), onUpdateFn);
    }

    async streamPythEma(product, onUpdateFn): Promise<ReliableWebSocket> {
        return this.streamPythEmaFromPubkey(await this.getOracle(product), onUpdateFn);
    }

    streamPythEmaFromPubkey(oraclePubkey, onUpdateFn): ReliableWebSocket {
        const socket = this.accountSubscribe(
            oraclePubkey,
            async (data, manifest) => {
                const expOffset = 4*4 + 4;
                const twapOffset = 4*4 + 4*4 + 8*2;
                const expData = data.slice(expOffset, expOffset+4);
                const twapData = data.slice(twapOffset, twapOffset+8);
                const exp = new BN(expData, undefined, 'le').fromTwos(8*4).abs();
                const twap = new BN(twapData, undefined, 'le').fromTwos(8*8);
                return new Fractional(twap, exp);
            },
            onUpdateFn,
        );
        return socket;
    }

    streamPythPriceFromPubkey(oraclePubkey, onUpdateFn): ReliableWebSocket {
        const socket = this.accountSubscribe(
            oraclePubkey,
            async (data, manifest) => {
                const expOffset = 4*4 + 4;
                const aggOffset = 4*4 + 4*4 + 8*2 + 24*2 + 8 + 1 + 1 + 2 + 4 + 32*2 + 8*4;
                // this variable is named "agg" because that's what it's called in the pyth struct
                // see "PriceAccountPythnet" in https://github.com/pyth-network/pyth-client/blob/main/program/rust/src/accounts/price.rs
                const expData = data.slice(expOffset, expOffset+4);
                const aggData = data.slice(aggOffset, aggOffset+8);
                const exp = new BN(expData, undefined, 'le').fromTwos(8*4).abs();
                const agg = new BN(aggData, undefined, 'le').fromTwos(8*8);
                return new Fractional(agg, exp);
            },
            onUpdateFn,
        );
        return socket;
    }

    // returns list of public keys
    async getTRGsOfOwner(owner: web3.PublicKey, marketProductGroup: web3.PublicKey = null) {
        const dexProgram = this.fields.dexProgram;
        const filters = [
            {
                memcmp: {
                    offset: 0,
                    bytes: 'MPWU8bY6pNK', // base58-encoded string representation of the TRG anchor discriminator
                },
                // memcmp: {
                //     offset: 8, // 8-byte anchor discriminator
                //     bytes: '3', // base58-encoded string representation of the number 2, the account tag for TRGs
                // },
            },
            {
                memcmp: {
                    offset: 48, // 8-byte anchor discriminator + 8-byte tag + 32-byte mpg pk
                    bytes: owner.toBase58(),
                },
            },
        ];
        if (marketProductGroup !== null) {
            filters.push({
                memcmp: {
                    offset: 16, // 8-byte anchor discriminator + 8-byte tag
                    bytes: marketProductGroup.toBase58(),
                },
            })
        }
        const accounts = await dexProgram.provider.connection.getParsedProgramAccounts(
            dexProgram.programId,
            { filters }
        );
        const trgs = [];
        await Promise.all(accounts.map(async ({ account, pubkey }, i) => {
            trgs.push({ pubkey, trg: await this.getTRGFromData(account.data) });
        }));
        return trgs;
    }

    async getTRGsOfWallet(marketProductGroup: web3.PublicKey = null) {
        return await this.getTRGsOfOwner(this.fields.wallet.publicKey, marketProductGroup);
    }

    async closeTrg(marketProductGroup: web3.PublicKey, traderRiskGroup: web3.PublicKey) {
        const dexProgram = this.fields.dexProgram;
        const connection = this.fields.dexProgram.provider.connection;
        const wallet = this.fields.wallet;
        const mpg = await this.getMPG(marketProductGroup);
        const trg = await this.getTRG(traderRiskGroup);
        {
            const tx = new web3.Transaction().add(
                await dexProgram.instruction.closeTraderRiskGroup({
                    accounts: {
                        riskEngineProgram: mpg.riskEngineProgramId,
                        riskSigner: Manifest.GetRiskAndFeeSigner(marketProductGroup),
                        owner: wallet.publicKey,
                        traderRiskGroup: traderRiskGroup,
                        marketProductGroup: marketProductGroup,
                        traderRiskStateAcct: trg.riskStateAccount,
                        receiver: wallet.publicKey,
                        systemProgram: web3.SystemProgram.programId,
                    }
                })
            );
            try {
                let {blockhash} = await connection.getRecentBlockhash();
                tx.recentBlockhash = blockhash;
                tx.feePayer = wallet.publicKey;
                const signedTx = await wallet.signTransaction(tx);
                const sig = await connection.sendRawTransaction(signedTx.serialize());
                await connection.confirmTransaction(sig); // TODO: indicate to user that the transaction is being confirmed
            } catch (e) {
                console.error(e);
                console.error(e.logs);
                return null;
            }
        }
    }

    async createTrg(marketProductGroup: web3.PublicKey) {
        const dexProgram = this.fields.dexProgram;
        const connection = this.fields.dexProgram.provider.connection;
        const wallet = this.fields.wallet;
        const mpg = await this.getMPG(marketProductGroup);
        const riskStateAccount = new web3.Keypair();
        const traderRiskGroup = new web3.Keypair();
        const [traderFeeAccount, traderFeeAccountBump] = web3.PublicKey.findProgramAddressSync(
            [marketProductGroup.toBuffer(), traderRiskGroup.publicKey.toBuffer(), mpg.feeModelConfigurationAcct.toBuffer()],
            mpg.feeModelProgramId
        );
        const riskAndFeeSigner = Manifest.GetRiskAndFeeSigner(marketProductGroup);

        {
            // create trg account ix + intialize trg ix
            const rentExemptionAmount =
                await connection.getMinimumBalanceForRentExemption(TRG_SIZE);
            const tx = new web3.Transaction().add(
                await dexProgram.account.traderRiskGroup.createInstruction(traderRiskGroup, TRG_SIZE)
            ).add(
                await dexProgram.instruction.initializeTraderRiskGroup({ accounts: {
                    owner: wallet.publicKey,
                    traderRiskGroup: traderRiskGroup.publicKey,
                    marketProductGroup: marketProductGroup,
                    riskSigner: riskAndFeeSigner,
                    traderRiskStateAcct: riskStateAccount.publicKey,
                    traderFeeStateAcct: traderFeeAccount,
                    riskEngineProgram: mpg.riskEngineProgramId,
                    feeModelConfigurationAcct: mpg.feeModelConfigurationAcct,
                    feeModelProgram: mpg.feeModelProgramId,
                    systemProgram: web3.SystemProgram.programId,
                }})
            );
            try {
                let { blockhash } = await connection.getRecentBlockhash();
                tx.recentBlockhash = blockhash;
                tx.feePayer = wallet.publicKey;
                tx.sign(traderRiskGroup, riskStateAccount);
                const signedTx = await wallet.signTransaction(tx);
                const sig = await connection.sendRawTransaction(signedTx.serialize());
                await connection.confirmTransaction(sig); // TODO: indicate to user that the transaction is being confirmed
            } catch (e) {
                console.error(e);
                console.error(e.logs);
                return null;
            }
        }
        return traderRiskGroup.publicKey;
    }

    async fetchOrderbooks(marketProductGroup: web3.PublicKey = null)  {
        const confirmOptions: web3.ConfirmOptions = { preflightCommitment: 'processed' }; // TODO: pull from this
        for (const [k, { pubkey, mpg, orderbooks, covarianceMetadata }] of this.fields.mpgs) {
            if (marketProductGroup !== null && !pubkey.equals(marketProductGroup)) {
                continue;
            }
            for (let [productName, { index, product }] of Manifest.GetActiveProductsOfMPG(mpg)) {
                // await new Promise(_ => { setTimeout(100); });
                const meta = productToMeta(product);
                let marketState = null;
                try {
                    marketState = await MarketState.retrieve(
                        this.fields.connection,
                        meta.orderbook,
                        confirmOptions.preflightCommitment,
                    );
                } catch (e) {
                    // this assumes the orderbook is missing because it has been removed via expire bot
                    console.debug('potentially missing orderbook');
                    console.debug(e);
                }
                orderbooks.set(meta.orderbook.toBase58(), marketState);
            }
            this.fields.mpgs.set(k, { pubkey, mpg, orderbooks, covarianceMetadata });
        }
    }
    async fetchOrderbook(orderbook: web3.PublicKey)  {
        const confirmOptions: web3.ConfirmOptions = { preflightCommitment: 'processed' }; // TODO: pull from this
        let result = null;
        for (const [k, { pubkey, mpg, orderbooks, covarianceMetadata }] of this.fields.mpgs) {
            for (let [productName, { index, product }] of Manifest.GetActiveProductsOfMPG(mpg)) {
                const meta = productToMeta(product);
                if (meta.orderbook.equals(orderbook)) {
                    const marketState = await MarketState.retrieve(
                        this.fields.connection,
                        orderbook,
                        confirmOptions.preflightCommitment,
                    );
                    result = marketState;
                    orderbooks.set(orderbook.toBase58(), marketState);
                    break;
                }
            }
            if (result !== null) {
                this.fields.mpgs.set(k, { pubkey, mpg, orderbooks, covarianceMetadata });
                break;
            }
        }
        return result;
    }

    async getFills(productName: string, trg: web3.PublicKey, before: number, after: number) {
        try {
            let url = `${this.base_api_url}/fills?product=${productName}`;
            if (trg != null) {
                url += `&trg=${trg}`;
            }
            if (before != null && before > 0) {
                url += `&before=${before}`;
            }
            if (after != null && after > 0) {
                url += `&after=${after}`;
            }

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                },
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch fills: ${response.status}`);
            }

            const result = (await response.json()) as GetFillsResponse;
            return result;
        } catch (error) {
            if (error instanceof Error) {
                console.log('error message: ', error.message);
                return error.message;
            } else {
                console.log('unexpected error: ', error);
                return 'An unexpected error occurred';
            }
        }
    }

    async updateOrderbooks(marketProductGroup: web3.PublicKey) {
        const { pubkey, mpg, orderbooks } = this.fields.mpgs.get(marketProductGroup.toBase58());
        for (let [productName, { index, product }] of Manifest.GetActiveProductsOfMPG(mpg)) {
            const meta = productToMeta(product);
            // console.log('fetching orderbook', productName, meta.orderbook.toBase58());
            try {
                const marketState = await MarketState.retrieve(
                    this.fields.dexProgram.provider.connection,
                    meta.orderbook,
                    'processed',
                );
                orderbooks.set(meta.orderbook.toBase58(), marketState);
            } catch {
                console.log('failed to retrieve orderbook', meta.orderbook.toBase58());
            }
        }
    }

    async updateCovarianceMetadatas() {
        const newMpgs = new Map();
        for (const [k, obj] of this.fields.mpgs) {
            try {
                obj.covarianceMetadata = await this.getCovarianceMetadata(obj.pubkey, obj.mpg);
                newMpgs.set(k, obj);
            } catch (e) {} // allow missing covariance metadatas
        }
        this.fields.mpgs = newMpgs;
    }

    // gets BN representation of 'size' bytes at 'offset' within data (uint8array)
    static GetRiskNumber(data, offset, size, isSigned = true) {
        if (isSigned) {
            return new BN(data.slice(offset,offset+size), undefined, 'le').fromTwos(size*8);
        }
        return new BN(data.slice(offset,offset+size), undefined, 'le');
    }

    getStds(marketProductGroup: web3.PublicKey) {
        const { covarianceMetadata } = this.fields.mpgs.get(marketProductGroup.toBase58());
        let offset = 8 + // anchor discriminator
            8 + // tag
            8 + // slot
            32; // authority pubkey
        const numActiveProducts = Manifest.GetRiskNumber(covarianceMetadata, offset, 8, false);
        offset += 8;
        let stds = new Map();
        for (let i = 0; i < numActiveProducts; i++) {
            const pubkey = new web3.PublicKey(covarianceMetadata.slice(offset+32*i,offset+32*(i+1)));
            const std = Manifest.FromFastInt(Manifest.GetRiskNumber(covarianceMetadata, offset+MAX_OUTRIGHTS*32+16*i, 16, true));
            stds.set(pubkey.toBase58(), std);
        }
        return stds;
    }
}

async function getManifest(rpc: string, useCache = false, wallet: DexterityWallet | Wallet): Promise<Manifest> {
    const key = wallet ? (wallet.publicKey + ':' + rpc) : (':' + rpc);
    // console.debug('getting manifest', key);
    if (useCache && rpc2manifest.has(key)) {
        // console.debug('using cache to get manifest', key);
        return rpc2manifest.get(key);
    }
    const confirmOptions: web3.ConfirmOptions = { preflightCommitment: 'processed' };
    const connection = new web3.Connection(rpc, confirmOptions.preflightCommitment);
    const provider = new AnchorProvider(connection, wallet, confirmOptions);
    let dexProgram = createDexProgram(provider);
    let instrumentsProgram = createInstrumentsProgram(provider);
    let riskProgram = createRiskProgram(provider);

    // todo: remove this field from Manifest and grab it from orderbook object upon placing order
    let aaob_id = null;

    const accounts = await connection.getParsedProgramAccounts(
        DEX_ID,
        { filters: [
            {
                memcmp: {
                    offset: 0,
                    bytes: '4jPEYxHLRVw', // base58-encoded string representation of the MPG anchor discriminator
                },
                // memcmp: {
                //     offset: 8,
                //     bytes: '2', // base58-encoded string representation of the number 1, the account tag for MPGs
                // },
            },
        ] }
    );
    const mpgs = new Map();
    for (const [i, { account, pubkey }] of accounts.entries()) {
        const mpg = await Manifest.GetMPGFromData(dexProgram, account.data);
        const orderbooks = new Map();
        for (let [productName, { index, product }] of Manifest.GetProductsOfMPG(mpg)) {
            const meta = productToMeta(product);
            if (aaob_id === null) {
                const accinfo = await connection.getAccountInfo(meta.orderbook);
                if (accinfo === null) {
                    // it's okay to fail to load an orderbook
                    // in the failure case, we move on silently and fail later when the orderbook is actually used
                    continue;
                }
                aaob_id = accinfo.owner;
            }
        }
        mpgs.set(pubkey.toBase58(), { pubkey, mpg, orderbooks });
    }
    if (aaob_id == null) {
        throw new Error("failed to find a single mpg");
    }
    const manifest: Manifest = new Manifest({
        rpc,
        wallet,
        connection,
        dexProgram,
        instrumentsProgram,
        riskProgram,
        aaob_id,
        dex_id: DEX_ID,
        mpgs,
        creationTime: Date.now(),
    });
    rpc2manifest.set(key, manifest);
    // console.debug('cached manifest', rpc);
    // console.debug('got manifest', manifest);
    return manifest;
}

function bytesToString(bytes) {
    return bytes.map(c => String.fromCharCode(c)).join('');
}

function ten() {
    return new BN(10);
}

function zero() {
    return new BN(0);
}

function one() {
    return new BN(1);
}

function negativeOne() {
    return new BN(-1);
}

class Fractional {
    m: BN;
    exp: BN;
    _isNan: boolean;

    constructor(m: BN, exp: BN) {
        this.m = m;
        this.exp = exp;
        this._isNan = false;
    }

    // Fractional.New accepts numbers
    // whereas the constructor accepts BNs
    static New(m: number, exp: number): Fractional {
        return new Fractional(new BN(m), new BN(exp));
    }

    static From(simple: { m: BN, exp: BN }): Fractional {
        return Fractional.New(simple.m, simple.exp);
    }

    static FromString(s: string): Fractional {
        const f = parseFloat(s);
        if (isNaN(f)) {
            return Fractional.Nan();
        }
        s = f.toString();
        const i = s.indexOf('.');
        if (i < 0) {
            return new Fractional(new BN(s.replace(/\./g, '')), new BN(0));
        }
        return new Fractional(new BN(s.replace(/\./g, '')), new BN(s.length - i - 1));
    }

    static Zero(): Fractional {
        return Fractional.New(0, 0);
    }

    static One(): Fractional {
        return Fractional.New(1, 0);
    }

    static NegativeOne(): Fractional {
        return Fractional.New(-1, 0);
    }

    static NoBidPrice(): Fractional {
        return Fractional.New(-9007199254740991, 0); // 64 bits cannot fit in BN :(
    }

    static NoAskPrice(): Fractional {
        return Fractional.New(9007199254740991, 0); // 64 bits cannot fit in BN :(
    }

    static Nan() {
        let f = Fractional.Zero();
        f._isNan = true;
        return f;
    }

    isNan() {
        return this._isNan;
    }

    isZero() {
        if (this._isNan) {
            return false;
        }
        return this.m.isZero();
    }

    max(other: Fractional): Fractional {
        if (this.gt(other)) {
            return this.reduced();
        }
        return other.reduced();
    }

    toNumber(): number { // converts to whole number
        if (this._isNan) {
            return NaN;
        }
        return Math.floor(this.toDecimal());
    }

    toDecimal(): number { // converts to decimal
        if (this._isNan) {
            return NaN;
        }
        let r = this.reduced();
        if (r.m.bitLength() > 53) {
            const bitDiff = r.m.bitLength() - 53 + 1;
            // 2^10 ~ 10^3, we need to convert base 2 powers to base 10 powers
            // so divide by 10 and multiply by 3
            r = r.round_down(r.exp.sub(new BN(Math.ceil(bitDiff / 10 * 3))));
        }
        return r.m.toNumber() / Math.pow(10, r.exp.toNumber());
    }

    // scale multiplies returns a new Fractional with this.m multiplied by c
    scale(c: number): Fractional {
        if (this._isNan) {
            return Fractional.Nan();
        }
        return new Fractional(this.m.mul(new BN(c)), this.exp);
    }

    // scale multiplies returns a new Fractional with this.m divided by c
    scaledown(c: number): Fractional {
        if (this._isNan) {
            return Fractional.Nan();
        }
        return new Fractional(this.m.div(new BN(c)), this.exp);
    }

    add(other: Fractional): Fractional {
        if (this._isNan || other._isNan) {
            return Fractional.Nan();
        }
        const cmp = this.exp.cmp(other.exp);
        if (cmp == 0) {
            return new Fractional(this.m.add(other.m), this.exp);
        } else if (cmp < 0) {
            return new Fractional(
                this.round_up(other.exp).m.add(other.m),
                other.exp,
            );
        } else {
            return new Fractional(
                other.round_up(this.exp).m.add(this.m),
                this.exp,
            );
        }
    }

    round_up(newExp: BN): Fractional {
        if (newExp.lt(this.exp)) {
            throw new Error("cannot use Fractional.round_up to round down");
        }
        return new Fractional(
            this.m.mul(ten().pow(newExp.sub(this.exp))),
            newExp,
        );
    }

    round_down(newExp: BN): Fractional {
        if (newExp.gt(this.exp)) {
            throw new Error("cannot use Fractional.round_down to round up");
        }
        return new Fractional(
            this.m.div(ten().pow(this.exp.sub(newExp))),
            newExp,
        );
    }

    sub(other: Fractional): Fractional {
        if (this._isNan) {
            return Fractional.Nan();
        }
        return this.add(new Fractional(
            other.m.mul(negativeOne()),
            other.exp,
        ));
    }

    sign(): BN {
        if (this._isNan) {
            return new BN(1);
        }
        return this.m.isNeg() ? new BN(-1) : new BN(1);
    }

    sqrt(): BN {
        if (this._isNan) {
            return Fractional.Nan();
        }
        let m = this.m;
	let exp = this.exp;
	if (!exp.umod(new BN(2)).isZero()) {
	    exp = exp.add(new BN(1));
	    m = m.mul(new BN(10));
	}
	m = m.mul(new BN(1000000));
	exp = exp.add(new BN(6));
        return new Fractional(bnSqrt(this.m), exp.sub(new BN(6+3))).reduced();
    }

    abs(): Fractional {
        if (this._isNan) {
            return Fractional.Nan();
        }
        return new Fractional(this.m.abs(), this.exp);
    }

    div(other: Fractional): Fractional {
        if (this._isNan || other._isNan || other.isZero()) {
            return Fractional.Nan();
        }
        const sign = this.sign();
        const otherSign = other.sign();
        const exp = this.exp.sub(other.exp);
        const shift = (!this.exp.isNeg()) ? ten() : (ten()).sub(this.exp);
        const dividend = this.m.abs().mul(ten().pow(shift));
        const divisor = other.m.abs();
        const quotient = dividend.div(divisor);
        const newExp = exp.add(shift);
        const newSign = sign.mul(otherSign);
        return (new Fractional(newSign.mul(quotient), newExp)).reduced();
    }

    mul(other): Fractional {
        if (this._isNan || other._isNan) {
            return Fractional.Nan();
        }
	const r1 = this.reduced();
	const r2 = other.reduced();
        return new Fractional(
            r1.m.mul(r2.m),
            r1.exp.add(r2.exp),
        );
    }

    reduced(): Fractional {
        if (this._isNan) {
            return Fractional.Nan();
        }
        if (this.exp.isZero()) {
            return new Fractional(this.m, this.exp);
        }
        if (this.m.isZero()) {
            return Fractional.New(0, 0);
        }
        let m = this.m;
        let exp = this.exp;
        while (m.umod(ten()).isZero() && exp.gt(zero())) {
            m = m.div(ten());
            exp = exp.sub(one());
        }
        return new Fractional(m, exp);
    }

    // cmp returns NaN if either is NaN
    // cmp returns -1 if this < other
    // cmp returns 0 if this == other
    // cmp returns +1 if this > other
    cmp(other: Fractional): number {
        if (this._isNan || other._isNan) {
            return NaN;
        }
        if (this.m.isZero() || other.m.isZero()) {
            return this.m.cmp(other.m);
        }
        const r1 = this.reduced();
        const r2 = other.reduced();
        if (r1.exp.eq(r2.exp)) {
            return r1.m.cmp(r2.m);
        }
        // trick here:
        // switch the exponents of r1 and r2 when comparing
        return r1.m.mul(new BN(10).pow(r2.exp)).cmp(
            r2.m.mul(new BN(10).pow(r1.exp)));
    }

    lt(other: Fractional): boolean {
        return this.cmp(other) < 0;
    }

    lte(other: Fractional): boolean {
        return this.cmp(other) <= 0;
    }

    eq(other: Fractional): boolean {
        return this.cmp(other) == 0;
    }

    gt(other: Fractional): boolean {
        return this.cmp(other) > 0;
    }

    gte(other: Fractional): boolean {
        return this.cmp(other) >= 0;
    }

    toString(fixedDecimals = null, isInsertCommas = false): string {
        let result = this._toString(fixedDecimals);
        if (isInsertCommas) {
            let dotIndex = result.indexOf('.');
            if (dotIndex == -1) {
                dotIndex = result.length;
            }
            do {
                dotIndex -= 3;
                if (dotIndex <= 0 || (dotIndex === 1 && result[0] === '-')) {
                    break;
                }
                result = result.slice(0, dotIndex) + ',' + result.slice(dotIndex);
            } while (true);
        }
        return result;
    }
    _toString(fixedDecimals = null): string {
        if (this._isNan) {
            return 'NaN';
        }
        const reduced = this.reduced();
        const isNegative = reduced.m.negative == 1;
        let mstr = reduced.m.toString();
        if (reduced.exp.isZero()) {
            if (fixedDecimals === null || fixedDecimals === 0) {
                return mstr;
            }
            return mstr + '.' + '0'.repeat(fixedDecimals);
        }
        if (isNegative) {
            mstr = mstr.slice(1, mstr.length);
        }
        let result;
        if (reduced.exp < mstr.length) {
            result = (mstr.slice(0, mstr.length-reduced.exp) + '.' + mstr.slice(-reduced.exp))
                         .replace(/0*$/g, '').replace(/\.$/g, '');
        } else {
            result = ('0.' + '0'.repeat(reduced.exp - mstr.length) + mstr).replace(/0*$/g, '').replace(/\.$/g, '');
        }
        if (isNegative) {
            result = "-" + result;
        }
        if (fixedDecimals === null) {
            return result;
        }
        const dotIndex = result.indexOf('.');
        if (dotIndex == -1) {
            if (fixedDecimals === 0) {
                return result;
            }
            return result + '.' + '0'.repeat(fixedDecimals);
        }
        if (fixedDecimals === 0) {
            return result.slice(0, dotIndex);
        }
        const paddedZeros = dotIndex + fixedDecimals - result.length + 1;
        return result.slice(0, dotIndex + fixedDecimals + 1) + '0'.repeat(paddedZeros > 0 ? paddedZeros : 0);
    }
}

const MAX_ASK = new BN(2).pow(new BN(63)).subn(1);
const MIN_BID = new BN(2).pow(new BN(63)).neg();
const ZERO_BN = new BN(0);

const NUM_LIQUIDATION_STDS = Fractional.New(15, 1);
const NUM_UNHEALTHY_STDS = Fractional.New(3, 0);

function getEnumVariantAsString(someEnum) {
    const props = Object.getOwnPropertyNames(someEnum);
    if (props.length !== 1) {
        return 'Invalid Enum';
    }
    return props[0];
}

function getPriceDecimals(meta) {
//     // this is so hacky lol
//     let tickSize = Fractional.From(meta.tickSize).toString();
//     const i = tickSize.indexOf('.');
//     if (i !== -1) {
//         return tickSize.length - i - 1;
//     }
//     return 0;
    return meta.tickSize.exp.toNumber(); // assuming no trailing zeros
}

function productStatus(p, productArray) {
    if (p.hasOwnProperty('outright')) {
        return getEnumVariantAsString(p.outright.outright.productStatus);
    }
    for (const [i, leg] of p.combo.combo.legs.slice(0, p.combo.combo.numLegs.toNumber()).entries()) {
        const status = productStatus(productArray[leg.productIndex.toNumber()], productArray);
        if (status !== 'initialized') {
            return status;
        }
    }
    return 'initialized';
}

function productToMeta(p) {
    if (p.hasOwnProperty('outright')) {
        return p.outright.outright.metadata;
    } else {
        return p.combo.combo.metadata;
    }
}

function productToName(p) {
    return bytesToString(productToMeta(p).name);
}

type VarianceCache = Uint8Array;
type CovarianceMetadata = Uint8Array;

enum TraderUpdateType {
    TRG,
    MPG,
    Risk,
    MarkPrices,
    EventQueue,
}

type Slot = number;

// one Trader per trader risk group
// one or more trader risk groups per market product group
export class Trader {
    manifest: Manifest;
    feeAccount: web3.PublicKey;
    feeAccountBump: number;
    marketProductGroup: web3.PublicKey;
    traderRiskGroup: web3.PublicKey;
    riskStateAccount: web3.PublicKey;
    markPricesAccount: web3.PublicKey;
    hardcodedOracle: web3.PublicKey;
    priceOracles: Map<string, web3.PublicKey>;
    // maps product pk str to EventQueue object. Updated via websocket.
    eventQueues: Map<string, EventQueue>;

    mpg: MarketProductGroup;
    trg: TraderRiskGroup;
    varianceCache: VarianceCache;
    markPrices: MarkPricesArray;
    addressLookupTableAccount: web3.AddressLookupTableAccount;

    trgSlot: Slot;
    mpgSlot: Slot;
    riskSlot: Slot;
    markPricesSlot: Slot;

    skipThingsThatRequireWalletConnection: boolean;
    priorityFeesMicroLamports: number;

    constructor(
        manifest: Manifest,
        traderRiskGroup: web3.PublicKey,
        skipThingsThatRequireWalletConnection: boolean = false,
        priorityFeesMicroLamports: number = 60000,
    ) {
        this.manifest = manifest;
        this.traderRiskGroup = traderRiskGroup;
        this.skipThingsThatRequireWalletConnection = skipThingsThatRequireWalletConnection;
        this.priorityFeesMicroLamports = priorityFeesMicroLamports;
        this.eventQueues = new Map();
    }

    getProducts() {
        return Manifest.GetProductsOfMPG(this.mpg);
    }

    // getPositions returns the list of positions on the cached view of the TRG.
    // It does not take into account information from the EventQueue.
    // The EventQueue reveals that certain orders have already been partially or fully filled
    // or canceled.
    getPositions() {
        let m = new Map();
        for (let p of this.trg.traderPositions) {
            if (p.productKey.toBase58() === UNINITIALIZED || "uninitialized" in p.tag) {
                continue;
            }
            m.set(productToMeta(this.mpg.marketProducts.array[p.productIndex]).name.map(c => String.fromCharCode(c)).join(''), Fractional.From(p.position));
        }
        return m;
    }

    // getPositionsOptimistic returns the list of positions on the cached view of the TRG,
    // combining information from the EventQueue.
    // The EventQueue reveals that certain orders have already been partially or fully filled
    // or canceled.
    getPositionsOptimistic() {
        const mpgPkStr = this.marketProductGroup.toBase58();
        let m = new Map();
        for (let p of this.trg.traderPositions) {
            const pkStr = p.productKey.toBase58();
            if (pkStr === UNINITIALIZED || "uninitialized" in p.tag) {
                continue;
            }
            const product = Manifest.GetProductOfMpg(this.mpg, p.productKey);
            const meta = productToMeta(product);
            const name = productToName(product);
            const hasEventQueue = this.eventQueues.has(pkStr);
            const fillEvents = hasEventQueue ?
                Manifest.FillsFromEventQueue(this.eventQueues.get(pkStr), meta) :
                [];
            let qty = Fractional.From(p.position);
            for (const order of this.getOpenOrders([name])) {
                for (const fill of fillEvents) {
                    if (fill.makerOrderId.eq(order.id)) {
                        if (order.isBid) {
                            // console.log('saw corresponding fill in event queue! adding', fill.quantity.toString());
                            qty = qty.add(fill.quantity);
                        } else {
                            // console.log('saw corresponding fill in event queue! deducting', fill.quantity.toString());
                            qty = qty.sub(fill.quantity);
                        }
                    }
                }
            }

            m.set(productToMeta(this.mpg.marketProducts.array[p.productIndex]).name.map(c => String.fromCharCode(c)).join(''), qty);
        }
        return m;
    }

    getMultiplaceIx(productIndex, orders, referrerTrg=null, referrerFeeBps=null, matchLimit=null) {
        
        // isBid, limitPrice: Fractional, maxBaseQty: Fractional, orderType=OrderType.Limit, clientOrderId=null,

        const products = this.getProducts();
        let product = null;
        for (let { index, product: someProduct } of products.values()) {
            if (index === productIndex) {
                product = someProduct;
                break;
            }
        }
        if (product === null) {
            throw new Error('could not place new order because no product with that index exists. index: ' + productIndex);
        }
        if (product.hasOwnProperty('outright')) {
            product = product.outright.outright;
        } else {
            product = product.combo.combo;
        }
        const productPk = product.metadata.productKey;
        const orderbookPk = product.metadata.orderbook;
        const { orderbooks } = this.manifest.fields.mpgs.get(this.marketProductGroup.toBase58());
        const orderbook = orderbooks.get(orderbookPk.toBase58());

        const params = {
            selfTradeBehavior: { cancelProvide: {} },
            matchLimit: matchLimit ?? new BN(16),
            referrerFeeBps: {
                m: referrerFeeBps ? referrerFeeBps.m : new BN(0),
                exp: referrerFeeBps ? referrerFeeBps.exp : new BN(0)
            },
            orders: []
        };
        for (const order of orders) {
            const { isBid, orderType, maxBaseQty, limitPrice, clientOrderId } = order;
            const side = isBid ? { bid: {} } : { ask: {} };
            let oType;
            if (orderType == OrderType.FillOrKill) oType = {fillOrKill: {}};
            else if (orderType == OrderType.ImmediateOrCancel) oType = {immediateOrCancel: {}};
            else if (orderType == OrderType.PostOnly) oType = {postOnly: {}};
            else oType = {limit: {}};
            params.orders.push({
                side,
                maxBaseQty: {
                    m: maxBaseQty.m,
                    exp: maxBaseQty.exp
                },
                orderType: oType,
                limitPrice: {
                    m: limitPrice.m,
                    exp: limitPrice.exp
                },
                clientOrderId: clientOrderId ?? new BN(0),
            });
        }
        const stakerStateKey: web3.PublicKey = web3.PublicKey.findProgramAddressSync(
            [
                this.manifest.fields.wallet.publicKey.toBuffer(),
                Manifest.GetStakePool().toBuffer(),
            ],
            new web3.PublicKey(STAKING_ID),
        )[0];
        return this.manifest.fields.dexProgram.instruction.multiplace(params, { accounts: {
            // @ts-ignore
            user: this.manifest.fields.wallet.publicKey,
            traderRiskGroup: this.traderRiskGroup,
            marketProductGroup: this.marketProductGroup,
            product: productPk,
            aaobProgram: this.manifest.fields.aaob_id,
            orderbook: orderbookPk,
            marketSigner: orderbook.callerAuthority,
            eventQueue: orderbook.eventQueue,
            bids: orderbook.bids,
            asks: orderbook.asks,
            systemProgram: web3.SystemProgram.programId,
            feeModelProgram: this.mpg.feeModelProgramId,
            feeModelConfigurationAcct: this.mpg.feeModelConfigurationAcct,
            traderFeeStateAcct: this.trg.feeStateAccount,
            feeOutputRegister: this.mpg.feeOutputRegister,
            riskEngineProgram: this.mpg.riskEngineProgramId,
            riskModelConfigurationAcct: this.mpg.riskModelConfigurationAcct,
            riskOutputRegister: this.mpg.riskOutputRegister,
            traderRiskStateAcct: this.trg.riskStateAccount,
            riskAndFeeSigner: Manifest.GetRiskAndFeeSigner(this.marketProductGroup),
            covarianceMetadata: this.manifest.getRiskS(this.marketProductGroup, this.mpg),
            correlationMatrix: this.manifest.getRiskR(this.marketProductGroup, this.mpg),
            markPrices: this.markPricesAccount,
            referrerTrg: referrerTrg ?? this.traderRiskGroup,
            stakePool: Manifest.GetStakePool(),
            stakerState: stakerStateKey,
        }});
    }

    getNewOrderIx(productIndex, isBid, limitPrice: Fractional, maxBaseQty: Fractional,
                  orderType=OrderType.Limit, referrerTrg=null, referrerFeeBps=null, clientOrderId=null, matchLimit=null) {
        const products = this.getProducts();
        let product = null;
        for (let { index, product: someProduct } of products.values()) {
            if (index === productIndex) {
                product = someProduct;
                break;
            }
        }
        if (product === null) {
            throw new Error('could not place new order because no product with that index exists. index: ' + productIndex);
        }
        if (product.hasOwnProperty('outright')) {
            product = product.outright.outright;
        } else {
            product = product.combo.combo;
        }
        const productPk = product.metadata.productKey;
        const orderbookPk = product.metadata.orderbook;
        const { orderbooks } = this.manifest.fields.mpgs.get(this.marketProductGroup.toBase58());
        const orderbook = orderbooks.get(orderbookPk.toBase58());
        const side = isBid ? { bid: {} } : { ask: {} };
        let oType;
        if (orderType == OrderType.FillOrKill) oType = {fillOrKill: {}};
        else if (orderType == OrderType.ImmediateOrCancel) oType = {immediateOrCancel: {}};
        else if (orderType == OrderType.PostOnly) oType = {postOnly: {}};
        else oType = {limit: {}};
        const params = {
            side,
            maxBaseQty: {
                m: maxBaseQty.m,
                exp: maxBaseQty.exp
            },
            orderType: oType,
            selfTradeBehavior: { cancelProvide: {} },
            matchLimit: matchLimit ?? new BN(16),
            limitPrice: {
                m: limitPrice.m,
                exp: limitPrice.exp
            },
            referrerFeeBps: {
                m: referrerFeeBps ? referrerFeeBps.m : new BN(0),
                exp: referrerFeeBps ? referrerFeeBps.exp : new BN(0)
            },
            clientOrderId: clientOrderId ?? new BN(0),
        };
        const stakerStateKey: web3.PublicKey = web3.PublicKey.findProgramAddressSync(
            [
                this.manifest.fields.wallet.publicKey.toBuffer(),
                Manifest.GetStakePool().toBuffer(),
            ],
            new web3.PublicKey(STAKING_ID),
        )[0];
        return this.manifest.fields.dexProgram.instruction.newOrder(params, { accounts: {
            // @ts-ignore
            user: this.manifest.fields.wallet.publicKey,
            traderRiskGroup: this.traderRiskGroup,
            marketProductGroup: this.marketProductGroup,
            product: productPk,
            aaobProgram: this.manifest.fields.aaob_id,
            orderbook: orderbookPk,
            marketSigner: orderbook.callerAuthority,
            eventQueue: orderbook.eventQueue,
            bids: orderbook.bids,
            asks: orderbook.asks,
            systemProgram: web3.SystemProgram.programId,
            feeModelProgram: this.mpg.feeModelProgramId,
            feeModelConfigurationAcct: this.mpg.feeModelConfigurationAcct,
            traderFeeStateAcct: this.trg.feeStateAccount,
            feeOutputRegister: this.mpg.feeOutputRegister,
            riskEngineProgram: this.mpg.riskEngineProgramId,
            riskModelConfigurationAcct: this.mpg.riskModelConfigurationAcct,
            riskOutputRegister: this.mpg.riskOutputRegister,
            traderRiskStateAcct: this.trg.riskStateAccount,
            riskAndFeeSigner: Manifest.GetRiskAndFeeSigner(this.marketProductGroup),
            covarianceMetadata: this.manifest.getRiskS(this.marketProductGroup, this.mpg),
            correlationMatrix: this.manifest.getRiskR(this.marketProductGroup, this.mpg),
            markPrices: this.markPricesAccount,
            referrerTrg: referrerTrg ?? this.traderRiskGroup,
            stakePool: Manifest.GetStakePool(),
            stakerState: stakerStateKey,
        }});
    }

    async newOrder(productIndex, isBid, limitPrice: Fractional, maxBaseQty: Fractional,
                   orderType=OrderType.Limit, referrerTrg=null, referrerFeeBps=null, clientOrderId=null,
                   matchLimit=null,
                   callbacks,
                  ) {
        const ixs = [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS })];
        if (this.addressLookupTableAccount) {
            ixs.push(this.getUpdateMarkPricesIx());
        }
        ixs.push(this.getNewOrderIx(
                productIndex, isBid, limitPrice, maxBaseQty, orderType,
                referrerTrg, referrerFeeBps, clientOrderId, matchLimit
        ));
        return await this.sendTx(ixs, callbacks);
    }

    async justNewOrder(productIndex, isBid, limitPrice: Fractional, maxBaseQty: Fractional,
                   orderType=OrderType.Limit, referrerTrg=null, referrerFeeBps=null, clientOrderId=null,
                   matchLimit=null,
                   callbacks
                  ) {
        return await this.sendTx([
            web3.ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
            this.getNewOrderIx(
                productIndex, isBid, limitPrice, maxBaseQty, orderType,
                referrerTrg, referrerFeeBps, clientOrderId, matchLimit
            ),
        ], callbacks);
    }

    async updateVarianceCache(callbacks = undefined) {
        const ixs = [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS })];
        if (this.addressLookupTableAccount) {
            ixs.push(this.getUpdateMarkPricesIx());
        }
        ixs.push(this.getUpdateVarianceCacheIx());
        return await this.sendTx(ixs, callbacks);
    }

    async justUpdateVarianceCache(callbacks = undefined) {
        return await this.sendTx([
            web3.ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
            this.getUpdateVarianceCacheIx()
        ], callbacks);
    }

    getUpdateVarianceCacheIx() {
        const accounts = {
            // @ts-ignore
            payer: this.manifest.fields.wallet.publicKey,
            user: this.manifest.fields.wallet.publicKey,
            traderRiskGroup: this.traderRiskGroup,
            marketProductGroup: this.marketProductGroup,
            systemProgram: web3.SystemProgram.programId,
            riskEngineProgram: this.mpg.riskEngineProgramId,
            riskModelConfigurationAcct: this.mpg.riskModelConfigurationAcct,
            riskOutputRegister: this.mpg.riskOutputRegister,
            traderRiskStateAcct: this.trg.riskStateAccount,
            riskAndFeeSigner: Manifest.GetRiskAndFeeSigner(this.marketProductGroup),
            covarianceMetadata: this.manifest.getRiskS(this.marketProductGroup, this.mpg),
            correlationMatrix: this.manifest.getRiskR(this.marketProductGroup, this.mpg),
            markPrices: this.markPricesAccount,
        }
        return this.manifest.fields.dexProgram.instruction.updateVarianceCache({ accounts });
    }

    getUpdateMarkPricesIx(products: Array<Product> = null) {
        let remainingAccounts = [];

        if (products === null || products.length === 0) {
            products = [];
            for (const [_, { product }] of this.getProducts()) {
                products.push(product);
            }
        }

        let numProducts = 0;
        const { orderbooks } = this.manifest.fields.mpgs.get(this.marketProductGroup.toBase58());
        for (let p of products) {
            if (!p.hasOwnProperty('outright')) continue;
            const meta = productToMeta(p);

            const productKey = meta.productKey;
            if (meta.productKey.toString() === UNINITIALIZED) {
                continue;
            }
            const orderbookPk = meta.orderbook;
            const orderbook = orderbooks.get(orderbookPk.toBase58());

            remainingAccounts.push({ isSigner: false, isWritable: false, pubkey: productKey });
            if (this.hardcodedOracle != null) {
                remainingAccounts.push({ isSigner: false, isWritable: false, pubkey: this.hardcodedOracle });
            } else {
                remainingAccounts.push({ isSigner: false, isWritable: false, pubkey: this.priceOracles.get(productKey.toBase58()) });
            }
            remainingAccounts.push({ isSigner: false, isWritable: false, pubkey: orderbookPk });
            remainingAccounts.push({ isSigner: false, isWritable: false, pubkey: orderbook.bids });
            remainingAccounts.push({ isSigner: false, isWritable: false, pubkey: orderbook.asks });
            numProducts += 1;
        }

        const ix = this.manifest.fields.riskProgram.instruction.updateMarkPrices(
            { numProducts: new BN(numProducts) },
            {
                accounts: {
                    // @ts-ignore
                    payer: this.manifest.fields.wallet.publicKey,
                    marketProductGroup: this.marketProductGroup,
                    markPrices: this.markPricesAccount,
                },
                remainingAccounts
            }
        );

        ix.data[8] = numProducts; // FUCK ANCHOR

        return ix;
    }

    async initializePrintTrade(isBid, size, price, counterparty: web3.PublicKey) {
        // TODO product should be parameter
        const products = this.getProducts();
        let productAndIndex = null;
        for (let p of products.values()) {
            productAndIndex = p;
            break;
        }
        if (productAndIndex === null) {
            throw new Error('could not inintialize print trade because there are no products. see trader.getProducts()');
        }
        let product = null;
        if (productAndIndex.product.hasOwnProperty('outright')) {
            product = productAndIndex.product.outright.outright;
        } else {
            product = productAndIndex.product.combo.combo;
        }
        const productPk = product.metadata.productKey;
        const side = isBid ? { bid: {} } : { ask: {} };
        const params = {
            productIndex: new BN(productAndIndex.index),
            side,
            size: {
                m: size.m,
                exp: size.exp
            },
            price: {
                m: price.m,
                exp: price.exp
            }
        };
        const printTrade: web3.PublicKey = web3.PublicKey.findProgramAddressSync(
            [
                Buffer.from("print_trade", "utf-8"),
                productPk.toBuffer(),
                this.traderRiskGroup.toBuffer(),
                counterparty.toBuffer(),
            ],
            new web3.PublicKey(DEX_ID),
        )[0];
        const accounts = {
            user: this.manifest.fields.wallet.publicKey,
            creator: this.traderRiskGroup,
            counterparty: counterparty,
            marketProductGroup: this.marketProductGroup,
            product: productPk,
            printTrade: printTrade,
            systemProgram: web3.SystemProgram.programId,
        }
        try {
            // console.log(params);
            // console.log(accounts);
            // for (const [k, v] of Object.entries(accounts)) {
            //     console.log(k, v.toBase58());
            // }
            await this.manifest.fields.dexProgram.methods.initializePrintTrade(params)
                .accounts(accounts)
                .rpc();
        } catch (e) {
            console.error(e);
            console.error(e.logs);
            return;
        }
    }

    // getOpenOrders returns the list of open orders on the cached view of the TRG.
    // It does not take into account information from the EventQueue.
    // The EventQueue reveals that certain orders have already been partially or fully filled
    // or canceled.
    getOpenOrders(productNames): Set<Order> {
        const orders = new Set<Order>();
        let checkProduct = Array.isArray(productNames) && productNames.length > 0;
        for (const [name, { index, product }] of this.getProducts()) {
            const trimmedName = name.trim();
            if (checkProduct && !productNames.includes(trimmedName)) {
                continue;
            }

            const metadata = productToMeta(product);
            const tickSize = Fractional.From(metadata.tickSize);
            const priceOffset = Fractional.From(metadata.priceOffset);
            const baseDecimals = new BN(metadata.baseDecimals);

            let ptr = this.trg.openOrders.products[index].headIndex;
            let order = this.trg.openOrders.orders[ptr];
            if (order.prev !== SENTINEL) {
                throw new Error('openOrders state is invalid. expected first order.prev === SENTINEL\norder: ' + JSON.stringify(order));
            }
            while (ptr !== SENTINEL) {
                order = this.trg.openOrders.orders[ptr];
                if (order.id.isZero()) {
                    throw new Error('expected order id !== 0. order: ' + JSON.stringify(order));
                }
                orders.add(new Order(
                    order.id,
                    trimmedName,
                    index,
                    Manifest.orderIdToDexPrice(order.id, tickSize, priceOffset),
                    new Fractional(new BN(order.qty), baseDecimals),
                    Manifest.orderIdIsBid(order.id),
                ));
                ptr = order.next;
            }
        }
        return orders;
    }

    // getOpenOrdersOptimistic returns the list of open orders on the cached view of the TRG,
    // combining information from the EventQueue.
    // The EventQueue reveals that certain orders have already been partially or fully filled
    // or canceled.
    getOpenOrdersOptimistic(productNames): Set<Order> {
        const orders = new Set<Order>();
        let checkProduct = Array.isArray(productNames) && productNames.length > 0;
        for (const [name, { index, product }] of this.getProducts()) {
            const trimmedName = name.trim();
            if (checkProduct && !productNames.includes(trimmedName)) {
                continue;
            }

            const metadata = productToMeta(product);
            const pkStr = metadata.productKey.toString();
            const tickSize = Fractional.From(metadata.tickSize);
            const priceOffset = Fractional.From(metadata.priceOffset);
            const baseDecimals = new BN(metadata.baseDecimals);

            const hasEventQueue = this.eventQueues.has(pkStr);
            const fillEvents = hasEventQueue ?
                Manifest.FillsFromEventQueue(this.eventQueues.get(pkStr), metadata) :
                [];
            const outEvents = hasEventQueue ?
                Manifest.OutsFromEventQueue(this.eventQueues.get(pkStr), metadata) :
                [];

            let ptr = this.trg.openOrders.products[index].headIndex;
            let order = this.trg.openOrders.orders[ptr];
            if (order.prev !== SENTINEL) {
                throw new Error('openOrders state is invalid. expected first order.prev === SENTINEL\norder: ' + JSON.stringify(order));
            }
            const zero = Fractional.Zero();
            while (ptr !== SENTINEL) {
                order = this.trg.openOrders.orders[ptr];
                if (order.id.isZero()) {
                    throw new Error('expected order id !== 0. order: ' + JSON.stringify(order));
                }
                let qty = new Fractional(new BN(order.qty), baseDecimals);
                for (const fill of fillEvents) {
                    if (fill.makerOrderId.eq(order.id)) {
                        // console.log('saw corresponding fill in event queue! deducting', fill.quantity.toString(), 'from order', order.id.toString());
                        qty = qty.sub(fill.quantity);
                    }
                }
                for (const out of outEvents) {
                    if (out.orderId.eq(order.id)) {
                        // console.log('saw corresponding out in event queue! omitting order ', order.id.toString());
                        qty = zero;
                        break;
                    }
                }
                if (!qty.eq(zero)) {
                    orders.add(new Order(
                        order.id,
                        trimmedName,
                        index,
                        Manifest.orderIdToDexPrice(order.id, tickSize, priceOffset),
                        qty,
                        Manifest.orderIdIsBid(order.id),
                    ));
                }
                ptr = order.next;
            }
        }
        return orders;
    }

    // returns orderids as set of strings (order ids)
    getOpenOrderIds(productName): Set<string> {
        const orderIds = new Set<string>();
        for (const [name, { index, product }] of this.getProducts()) {
            if (name.trim() !== productName.trim()) {
                continue;
            }
            let ptr = this.trg.openOrders.products[index].headIndex;
            let order = this.trg.openOrders.orders[ptr];
            if (order.prev !== SENTINEL) {
                throw new Error('openOrders state is invalid. expected first order.prev === SENTINEL\norder: ' + JSON.stringify(order));
            }
            while (ptr !== SENTINEL) {
                order = this.trg.openOrders.orders[ptr];
                if (order.id.isZero()) {
                    throw new Error('expected order id !== 0. order: ' + JSON.stringify(order));
                }
                orderIds.add(order.id.toString());
                ptr = order.next;
            }
        }
        return orderIds;
    }

    getCancelAllIx(productIndex) {
        let unwrappedProduct;
        for (const [name, { index, product }] of this.getProducts()) {
            if (index !== productIndex) {
                continue;
            }
            if (product.hasOwnProperty('outright')) {
                unwrappedProduct = product.outright.outright;
            } else {
                unwrappedProduct = product.combo.combo;
            }
            break;
        }
        const productPk = unwrappedProduct.metadata.productKey;
        const orderbookPk = unwrappedProduct.metadata.orderbook;
        const { orderbooks } = this.manifest.fields.mpgs.get(this.marketProductGroup.toBase58());
        const orderbook = orderbooks.get(orderbookPk.toBase58());
        const accounts = {
            // @ts-ignore
            user: this.manifest.fields.dexProgram.provider.wallet.publicKey,
            traderRiskGroup: this.traderRiskGroup,
            marketProductGroup: this.marketProductGroup,
            product: productPk,
            aaobProgram: this.manifest.fields.aaob_id,
            orderbook: orderbookPk,
            marketSigner: orderbook.callerAuthority,
            eventQueue: orderbook.eventQueue,
            bids: orderbook.bids,
            asks: orderbook.asks,
            feeModelProgram: this.mpg.feeModelProgramId,
            feeModelConfigurationAcct: this.mpg.feeModelConfigurationAcct,
            traderFeeStateAcct: this.trg.feeStateAccount,
            feeOutputRegister: this.mpg.feeOutputRegister,
            riskEngineProgram: this.mpg.riskEngineProgramId,
            riskModelConfigurationAcct: this.mpg.riskModelConfigurationAcct,
            riskOutputRegister: this.mpg.riskOutputRegister,
            traderRiskStateAcct: this.trg.riskStateAccount,
            riskSigner: Manifest.GetRiskAndFeeSigner(this.marketProductGroup),
            covarianceMetadata: this.manifest.getRiskS(this.marketProductGroup, this.mpg),
            correlationMatrix: this.manifest.getRiskR(this.marketProductGroup, this.mpg),
            markPrices: this.markPricesAccount,
        };
        return this.manifest.fields.dexProgram.instruction
            .cancelAll({}, { accounts });
    }

    getCancelOrderIx(productIndex, orderId, noErr = true, clientOrderId = null) {
        if (clientOrderId !== null) {
            orderId = new BN(0);
        }
        let unwrappedProduct;
        for (const [name, { index, product }] of this.getProducts()) {
            if (index !== productIndex) {
                continue;
            }
            if (product.hasOwnProperty('outright')) {
                unwrappedProduct = product.outright.outright;
            } else {
                unwrappedProduct = product.combo.combo;
            }
            break;
        }
        const productPk = unwrappedProduct.metadata.productKey;
        const orderbookPk = unwrappedProduct.metadata.orderbook;
        const { orderbooks } = this.manifest.fields.mpgs.get(this.marketProductGroup.toBase58());
        const orderbook = orderbooks.get(orderbookPk.toBase58());
        const accounts = {
            // @ts-ignore
            user: this.manifest.fields.dexProgram.provider.wallet.publicKey,
            traderRiskGroup: this.traderRiskGroup,
            marketProductGroup: this.marketProductGroup,
            product: productPk,
            aaobProgram: this.manifest.fields.aaob_id,
            orderbook: orderbookPk,
            marketSigner: orderbook.callerAuthority,
            eventQueue: orderbook.eventQueue,
            bids: orderbook.bids,
            asks: orderbook.asks,
            feeModelProgram: this.mpg.feeModelProgramId,
            feeModelConfigurationAcct: this.mpg.feeModelConfigurationAcct,
            traderFeeStateAcct: this.trg.feeStateAccount,
            feeOutputRegister: this.mpg.feeOutputRegister,
            riskEngineProgram: this.mpg.riskEngineProgramId,
            riskModelConfigurationAcct: this.mpg.riskModelConfigurationAcct,
            riskOutputRegister: this.mpg.riskOutputRegister,
            traderRiskStateAcct: this.trg.riskStateAccount,
            riskSigner: Manifest.GetRiskAndFeeSigner(this.marketProductGroup),
            covarianceMetadata: this.manifest.getRiskS(this.marketProductGroup, this.mpg),
            correlationMatrix: this.manifest.getRiskR(this.marketProductGroup, this.mpg),
            markPrices: this.markPricesAccount,
        };
        return this.manifest.fields.dexProgram.instruction
            .cancelOrder({ orderId, noErr, clientOrderId: clientOrderId ?? new BN(0) }, { accounts });
    }

    async cancelOrder(productIndex, orderId, noErr = true, clientOrderId = null, callbacks = undefined) {
        const ixs = [];
        const cancelIx = this.getCancelOrderIx(productIndex, orderId, noErr = true, clientOrderId = null);
        if (this.addressLookupTableAccount) {
            ixs.push(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }));
            ixs.push(this.getUpdateMarkPricesIx());
            ixs.push(cancelIx);
            ixs.push(this.getUpdateVarianceCacheIx());
        } else {
            ixs.push(cancelIx);
        }
        return await this.sendTx(ixs, callbacks);
    }

    // TODO: pack cancels for multiple products into one tx
    async cancelOrders(productIndex, orderIds, noErr = true, clientOrderIds = null, callbacks = undefined, maxCancelsPerTx = MAX_CANCELS_PER_TX) {
        if (clientOrderIds !== null) {
            orderIds = clientOrderIds; // for code re-use
        }
        const sigs = [];
        for (let i = 0; i < orderIds.length; i += maxCancelsPerTx) {
            const isLastChunk = i + maxCancelsPerTx >= orderIds.length;
            const orderIdsChunk = orderIds.slice(i, i + maxCancelsPerTx);
            const ixs = [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS })];
            for (let y = 0; y < orderIdsChunk.length; y++) {
                ixs.push(this.getCancelOrderIx(productIndex, orderIdsChunk[y], noErr, clientOrderIds !== null ? orderIdsChunk[y] : null));
            }
            if (isLastChunk && orderIdsChunk.length < (maxCancelsPerTx - 1)) {
                // TODO: mark prices ix
                ixs.push(this.getUpdateVarianceCacheIx());
            }
            sigs.push(await this.sendTx(ixs, callbacks));
        }
        return sigs;
    }

    // TODO: pack cancels for multiple products into one tx
    async cancelAllOrdersOneIx(productIndex, callbacks = undefined) {
        const ixs = [
            web3.ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
            this.getUpdateMarkPricesIx(),
            this.getCancelAllIx(productIndex),
            this.getUpdateVarianceCacheIx(),
        ];
        return await this.sendTx(ixs, callbacks);
    }

    async justCancelOrder(productIndex, orderId, noErr = true, clientOrderId = null, callbacks = undefined) {
        return await this.sendTx([
            this.getCancelOrderIx(productIndex, orderId, noErr = true, clientOrderId = null)
        ], callbacks);
    }

    // TODO: pack cancels for multiple products into one tx
    async justCancelOrders(productIndex, orderIds, noErr = true, clientOrderIds = null, callbacks = undefined, maxCancelsPerTx = MAX_CANCELS_PER_TX) {
        if (clientOrderIds !== null) {
            orderIds = clientOrderIds; // for code re-use
        }
        const sigs = [];
        for (let i = 0; i < orderIds.length; i += maxCancelsPerTx) {
            const isLastChunk = i + maxCancelsPerTx >= orderIds.length;
            const orderIdsChunk = orderIds.slice(i, i + maxCancelsPerTx);
            const ixs = [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS })];
            for (let y = 0; y < orderIdsChunk.length; y++) {
                ixs.push(this.getCancelOrderIx(productIndex, orderIdsChunk[y], noErr, clientOrderIds !== null ? orderIdsChunk[y] : null));
            }
            sigs.push(await this.sendTx(ixs, callbacks));
        }
        return sigs;
    }

    // TODO: pack cancels for multiple products into one tx
    async justCancelAllOrders(productIndex, callbacks = undefined) {
        const ixs = [
            web3.ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
            this.getCancelAllIx(productIndex),
        ];
        return await this.sendTx(ixs, callbacks);
    }

    async cancelAllOrders(productNames, isUseCache = false, justIssueCancels = false, maxCancelsPerTx = MAX_CANCELS_PER_TX) {
        if (!isUseCache) {
            this.trg = await this.manifest.getTRG(this.traderRiskGroup);
        }
        let sigs = [];
        for (const [name, { index, product }] of this.getProducts()) {
            if (productNames.length > 0 && !productNames.includes(name.trim())) {
                continue;
            }
            try {
                if (justIssueCancels) {
                    sigs = sigs.concat(await this.justCancelAllOrders(index));
                } else {
                    sigs = sigs.concat(await this.cancelAllOrdersOneIx(index));
                }
            } catch (error) {
                console.error('cancel all ix failed with error:', error);
                console.error('retrying with individual cancels');
                const orderIds = [];
                let ptr = this.trg.openOrders.products[index].headIndex;
                let order = this.trg.openOrders.orders[ptr];
                if (order.prev !== SENTINEL) {
                    throw new Error('openOrders state is invalid. expected first order.prev === SENTINEL. order: ' + JSON.stringify(order));
                }
                while (ptr !== SENTINEL) {
                    order = this.trg.openOrders.orders[ptr];
                    if (order.id.isZero()) {
                        throw new Error('expected order id !== 0. order: ' + JSON.stringify(order));
                    }
                    orderIds.push(order.id);
                    ptr = order.next;
                }
                if (orderIds.length > 0) {
                    if (justIssueCancels) {
                        sigs = sigs.concat(await this.justCancelOrders(index, orderIds, undefined, undefined, undefined, maxCancelsPerTx));
                    } else {
                        sigs = sigs.concat(await this.cancelOrders(index, orderIds, undefined, undefined, undefined, maxCancelsPerTx));
                    }
                }
            }
        }
        return sigs;
    }

    async getDepositIx(usdcAmount: Fractional) {
        const tradersVaultATA = await Manifest.GetATAFromMPGObject(this.mpg, this.manifest.fields.wallet.publicKey);
        const vaultNotMint = web3.PublicKey.findProgramAddressSync([Buffer.from("market_vault", "utf-8"), this.marketProductGroup.toBuffer()], new web3.PublicKey(DEX_ID))[0];
        const capitalLimits = web3.PublicKey.findProgramAddressSync([Buffer.from("capital_limits_state", "utf-8"), this.marketProductGroup.toBuffer()], new web3.PublicKey(DEX_ID))[0];
        const accounts = {
            tokenProgram: TOKEN_PROGRAM_ID,
            user: this.manifest.fields.wallet.publicKey,
            userTokenAccount:  tradersVaultATA,
            traderRiskGroup: this.traderRiskGroup,
            marketProductGroup: this.marketProductGroup,
            marketProductGroupVault: vaultNotMint,
            capitalLimits: capitalLimits,
            whitelistAtaAcct: capitalLimits, // WHITELIST IS UNUSED SO JUST PASS IN AN ARBITRARY ACCOUNT
        };
        const params = { quantity: { m: usdcAmount.m,  exp: usdcAmount.exp } };
        return this.manifest.fields.dexProgram.instruction.depositFunds(params, { accounts });
    }

    async fetchAddressLookupTableAccount() {
        if (!this.mpg?.addressLookupTable) {
            throw new Error('cannot fetch address lookup table account before mpg is fetched');
        }
        this.addressLookupTableAccount = await this.manifest.fields.dexProgram.provider.connection
            .getAddressLookupTable(this.mpg.addressLookupTable)
            .then((res) => res.value);
    }

    async signTx(wallet, tx) {
        try {
            const signedTx = await wallet.signTransaction(tx);
            return signedTx;
        } catch (e) {
            // console.error('failed to sign tx', e);
        }
        tx.sign([wallet.payer]);
        return tx;
    }

    async sendV0Tx(ixs, { onGettingBlockHashFn, onGotBlockHashFn, onTxSentFn }
        = { onGettingBlockHashFn: null, onGotBlockHashFn: null, onTxSentFn: null})
    {
        // @ts-ignore
        const wallet = this.manifest.fields.dexProgram.provider.wallet;
        const addressLookupTableAccounts = this.addressLookupTableAccount ? [this.addressLookupTableAccount] : [];
        const connection = this.manifest.fields.dexProgram.provider.connection;

        if (onGettingBlockHashFn) {
            onGettingBlockHashFn();
        }
        let { blockhash } = await connection.getRecentBlockhash();
        if (onGettingBlockHashFn) {
            onGettingBlockHashFn();
        }
        const tx = new web3.VersionedTransaction(new web3.TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: ixs,
        }).compileToV0Message(addressLookupTableAccounts));

        const signedTx = await this.signTx(wallet, tx);
        const signature = await connection.sendRawTransaction(signedTx.serialize());
        if (onTxSentFn) {
            onTxSentFn(signature);
        }
        await connection.confirmTransaction(signature);
        return signature;
    }

    async sendLegacyTx(ixs, { onGettingBlockHashFn, onGotBlockHashFn, onTxSentFn }
        = { onGettingBlockHashFn: null, onGotBlockHashFn: null, onTxSentFn: null}) {
        // @ts-ignore
        const wallet = this.manifest.fields.dexProgram.provider.wallet;
        const connection = this.manifest.fields.dexProgram.provider.connection;

        const tx = new web3.Transaction();
        for (const ix of ixs) {
            tx.add(ix);
        }

        if (onGettingBlockHashFn) {
            onGettingBlockHashFn();
        }
        let { blockhash } = await connection.getRecentBlockhash();
        if (onGettingBlockHashFn) {
            onGettingBlockHashFn();
        }
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        const signedTx = await wallet.signTransaction(tx);
        const signature = await connection.sendRawTransaction(signedTx.serialize());
        if (onTxSentFn) {
            onTxSentFn(signature);
        }
        await connection.confirmTransaction(signature);
        return signature;
    }

    async sendTx(ixs, callbacks) {
        if (this.priorityFeesMicroLamports > 0) {
            ixs.unshift(
                web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFeesMicroLamports }),
            );
        }
        if (!this.addressLookupTableAccount) {
            return await this.sendLegacyTx(ixs, callbacks);
        }
        return await this.sendV0Tx(ixs, callbacks);
    }

    async deposit(usdcAmount: Fractional, callbacks) {
        return await this.sendTx([
            web3.ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
            await this.getDepositIx(usdcAmount),
            this.getUpdateVarianceCacheIx(),
        ], callbacks);
    }

    async justDeposit(usdcAmount: Fractional, callbacks) {
        return await this.sendTx([await this.getDepositIx(usdcAmount)], callbacks);
    }

    async updateTraderRiskGroupOwner(newOwner: web3.PublicKey, oldOwner: web3.PublicKey = null) {
        try {
            if (oldOwner === null) {
                oldOwner = this.manifest.fields.wallet.publicKey;
            }
            const accounts = {
                owner: oldOwner,
                traderRiskGroup: this.traderRiskGroup,
                newOwner: newOwner,
            };
            await this.manifest.fields.dexProgram.methods
                .updateTraderRiskGroupOwner()
                .accounts(accounts)
                .rpc();
        } catch (e) {
            console.error(e);
            console.error(e.logs);
            return;
        }
    }
    /**
     * @param {Fractional} usdcAmount Amount to withdraw from Trader Account
     * @returns {Promise<web3.TransactionInstruction[]>} TransactionInstruction Array
     */
    async getWithdrawIx(usdcAmount: Fractional): Promise<web3.TransactionInstruction[]> {
            const tradersVaultATA = await Manifest.GetATAFromMPGObject(this.mpg, this.manifest.fields.wallet.publicKey);
            const tradersVaultATAInfo = await this.manifest.fields.connection.getAccountInfo(tradersVaultATA);
            let createAtaIx = null;
            if (!tradersVaultATAInfo) {
                createAtaIx = createAssociatedTokenAccountInstruction(
                    this.manifest.fields.wallet.publicKey, // fee payer
                    tradersVaultATA, // ata
                    this.manifest.fields.wallet.publicKey, // owner,
                    this.mpg.vaultMint, // mint
                );
                // console.log('creating traders ata for withdraw because it does not exist');
            }
            const vaultNotMint = web3.PublicKey.findProgramAddressSync([Buffer.from("market_vault", "utf-8"), this.marketProductGroup.toBuffer()], new web3.PublicKey(DEX_ID))[0];
            const capitalLimits = web3.PublicKey.findProgramAddressSync([Buffer.from("capital_limits_state", "utf-8"), this.marketProductGroup.toBuffer()], new web3.PublicKey(DEX_ID))[0];
            // console.log('tradersVaultATA:', tradersVaultATA.toString(), 'vaultNotMint:', vaultNotMint.toString(), 'capitalLimits:', capitalLimits.toString());
            const accounts = {
                tokenProgram: TOKEN_PROGRAM_ID,
                user: this.manifest.fields.wallet.publicKey,
                userTokenAccount:  tradersVaultATA,
                traderRiskGroup: this.traderRiskGroup,
                marketProductGroup: this.marketProductGroup,
                marketProductGroupVault: vaultNotMint,
                riskEngineProgram: this.mpg.riskEngineProgramId,
                riskModelConfigurationAcct: this.mpg.riskModelConfigurationAcct,
                riskOutputRegister: this.mpg.riskOutputRegister,
                traderRiskStateAcct: this.trg.riskStateAccount,
                riskSigner: Manifest.GetRiskAndFeeSigner(this.marketProductGroup),
                covarianceMetadata: this.manifest.getRiskS(this.marketProductGroup, this.mpg),
                correlationMatrix: this.manifest.getRiskR(this.marketProductGroup, this.mpg),
                capitalLimits: capitalLimits,
                markPrices: this.markPricesAccount,
            };
            const ixArr: web3.TransactionInstruction[] = []
            if (createAtaIx !== null) {
                ixArr.push(createAtaIx);
            }
            ixArr.push(
                this.manifest.fields.dexProgram.instruction.withdrawFunds(
                    { quantity: { m: usdcAmount.m,  exp: usdcAmount.exp } },
                    { accounts }
                )
            );
            return ixArr
    }

    async withdraw(usdcAmount: Fractional, callbacks: any): Promise<string> {
        try {
            const withdrawIxArr = await this.getWithdrawIx(usdcAmount)
            const txnHash = await this.sendTx(withdrawIxArr, callbacks)
            return txnHash
        } catch (e) {
            console.error(e);
            console.error(e.logs);
            return;
        }
    }

    async updateOrderbooks() {
        await this.manifest.updateOrderbooks(this.marketProductGroup);
    }

    streamUpdates(onUpdateFn) {
        this.manifest.accountSubscribe(
            this.traderRiskGroup,
            async (data, manifest) => await this.manifest.getTRGFromData(data),
            ((trg, slot) => { this.trg = trg; this.trgSlot = slot; onUpdateFn(TraderUpdateType.TRG); }).bind(this),
        );

        this.manifest.accountSubscribe(
            this.marketProductGroup,
            async (data, manifest) => await this.manifest.getMPGFromData(data),
            (async mpg => {
                this.mpg = mpg;
                onUpdateFn(TraderUpdateType.MPG);
            }).bind(this),
        );

        this.manifest.accountSubscribe(
            this.trg.riskStateAccount,
            async (data, manifest) => data,
            (varianceCache => {
                this.varianceCache = varianceCache;
                onUpdateFn(TraderUpdateType.Risk);
            }).bind(this),
        );

        this.manifest.accountSubscribe(
            this.markPricesAccount,
            async (data, manifest) => await this.manifest.getMarkPricesFromData(data),
            (markPrices => {
                this.markPrices = markPrices;
                onUpdateFn(TraderUpdateType.MarkPrices);
            }).bind(this),
        );

        for (const [name, { index, product }] of this.getProducts()) {
            const meta = productToMeta(product);
            const productPk = meta.productKey;
            const productPkStr = productPk.toString();
            const orderbookPk = meta.orderbook;
            const { orderbooks } = this.manifest.fields.mpgs.get(this.marketProductGroup.toBase58());
            const orderbook = orderbooks.get(orderbookPk.toBase58());
            this.manifest.accountSubscribe(
                orderbook.eventQueue,
                async (data, manifest) => Manifest.EventQueueFromData(data, orderbook),
                (eventQueue => {
                    this.eventQueues.set(productPkStr, eventQueue);
                    onUpdateFn(TraderUpdateType.EventQueue);
                }).bind(this),
            );
        }
    }

    async updateRisk() {
        this.varianceCache = await this.manifest.getVarianceCache(this.trg.riskStateAccount);
    }

    // gets BN representation of 'size' bytes at 'offset' within varianceCache
    getRiskNumber(offset, size, isSigned = true) {
        return Manifest.GetRiskNumber(this.varianceCache, offset, size, isSigned);
        // if (isSigned) {
        //     return new BN(this.varianceCache.slice(offset,offset+size), undefined, 'le').fromTwos(size*8);
        // }
        // return new BN(this.varianceCache.slice(offset,offset+size), undefined, 'le');
    }

    getVarianceCacheUpdateSlot() {
        if (this.varianceCache) {
            return this.getRiskNumber(16, 8, false).toNumber();
        }
    }

    getPositionValue() {
        if (this.varianceCache) {
            return Manifest.FromFastInt(this.getRiskNumber(24, 16));
        }
    }

    getTradedVariance() {
        if (this.varianceCache) {
            return Manifest.FromFastInt(this.getRiskNumber(40, 16));
        }
    }

    getOpenOrderVariance() {
        if (this.varianceCache) {
            return Manifest.FromFastInt(this.getRiskNumber(56, 16));
        }
    }

    getNotionalMakerVolume() {
        return Fractional.From(this.trg.notionalMakerVolume);
    }

    getNotionalTakerVolume() {
        return Fractional.From(this.trg.notionalTakerVolume);
    }

    getReferredTakersNotionalVolume() {
        return Fractional.From(this.trg.referredTakersNotionalVolume);
    }

    getReferralFees() {
        return Fractional.From(this.trg.referralFees);
    }

    getCashBalance() {
        return Fractional.From(this.trg.cashBalance);
    }

    getPendingCashBalance() {
        return Fractional.From(this.trg.pendingCashBalance);
    }

    getNetCash() {
        return this.getCashBalance().add(this.getPendingCashBalance());
    }

    getPortfolioValue() {
        if (this.varianceCache) {
            return this.getPositionValue().add(this.getNetCash());
        }
    }

    guessPortfolioValue() {
        let sum = this.getNetCash();
        for (let p of this.trg.traderPositions) {
            if (p.productKey.toBase58() === UNINITIALIZED || "uninitialized" in p.tag) {
                continue;
            }
            sum = sum.add(Fractional.From(p.position).mul(Manifest.GetMarkPrice(this.markPrices, p.productKey)));
        }
        return sum;
    }

    getTotalDeposited() {
        return Fractional.From(this.trg.totalDeposited);
    }

    getTotalWithdrawn() {
        return Fractional.From(this.trg.totalWithdrawn);
    }

    getDepositedCollateral() {
        return this.getTotalDeposited().sub(this.getTotalWithdrawn());
    }

    getPnL() {
        return this.getPortfolioValue().sub(this.getDepositedCollateral());
    }

    // getRequiredMaintenanceMargin gets margin required to prevent liquidation
    getRequiredMaintenanceMargin() {
        if (this.varianceCache) {
            const portfolioStd = BN.max(this.getTradedVariance(), this.getOpenOrderVariance()).sqrt();
            return portfolioStd.mul(NUM_LIQUIDATION_STDS);
        }
    }

    // getRequiredMaintenanceMarginWithoutOpenOrders gets margin required to prevent liquidation, assuming you don't have open orders
    getRequiredMaintenanceMarginWithoutOpenOrders() {
        if (this.varianceCache) {
            const portfolioStd = this.getTradedVariance().sqrt();
            return portfolioStd.mul(NUM_LIQUIDATION_STDS);
        }
    }

    // getRequiredInitialMargin gets margin required to prevent "unhealthy" state
    getRequiredInitialMargin() {
        if (this.varianceCache) {
            const portfolioStd = BN.max(this.getTradedVariance(), this.getOpenOrderVariance()).sqrt();
            return portfolioStd.mul(NUM_UNHEALTHY_STDS);
        }
    }

    // getRequiredInitialMarginWithoutOpenOrders gets margin required to prevent "unhealthy" state
    getRequiredInitialMarginWithoutOpenOrders() {
        if (this.varianceCache) {
            const portfolioStd = this.getTradedVariance().sqrt();
            return portfolioStd.mul(NUM_UNHEALTHY_STDS);
        }
    }

    // getExcessMaintenanceMargin gets margin in excess of liquidation threshold
    getExcessMaintenanceMargin() {
        if (this.varianceCache) {
            const portfolioStd = BN.max(this.getTradedVariance(), this.getOpenOrderVariance()).sqrt();
            return this.getPortfolioValue().sub(portfolioStd.mul(NUM_LIQUIDATION_STDS));
        }
    }

    // getExcessInitialMargin gets margin in excess of "unhealthy" threshold
    getExcessInitialMargin() {
        if (this.varianceCache) {
            const portfolioStd = BN.max(this.getTradedVariance(), this.getOpenOrderVariance()).sqrt();
            return this.getPortfolioValue().sub(portfolioStd.mul(NUM_UNHEALTHY_STDS));
        }
    }

    // getExcessMarginWithoutOpenOrders gets margin in excess of liquidation threshold, not counting open orders
    getExcessMaintenanceMarginWithoutOpenOrders() {
        if (this.varianceCache) {
            const portfolioStd = this.getTradedVariance().sqrt();
            return this.getPortfolioValue().sub(portfolioStd.mul(NUM_LIQUIDATION_STDS));
        }
    }

    // getExcessInitialMarginWithoutOpenOrders gets margin in excess of "unhealthy" threshold which prevents order placement, not counting open orders
    getExcessInitialMarginWithoutOpenOrders() {
        if (this.varianceCache) {
            const portfolioStd = this.getTradedVariance().sqrt();
            return this.getPortfolioValue().sub(portfolioStd.mul(NUM_UNHEALTHY_STDS));
        }
    }

    async updateMarkPrices() {
        this.markPricesAccount = this.manifest.getMarkPricesAccount(this.marketProductGroup, this.mpg);
        this.markPrices = await this.manifest.getMarkPrices(this.markPricesAccount);
        this.hardcodedOracle = null;
        if (this.markPrices.isHardcodedOracle) {
            this.hardcodedOracle = this.markPrices.hardcodedOracle;
        }
        this.priceOracles = new Map();
        for (let { index, product: p } of this.getProducts().values()) {
            if (!p.hasOwnProperty('outright')) {
                continue;
            }
            const productKey = p.outright.outright.metadata.productKey;
            try {
                // it's okay to fail to load derivative metadata
                // in the failure case, we move on silently and fail later when the dm is actually used
                const dm = await this.manifest.getDerivativeMetadata(productKey);
                this.priceOracles.set(productKey.toBase58(), dm.priceOracle);
            } catch (error) {
                // console.error('when attempting to get mark prices accounts, failed to get derivative metadata for product', productKey.toBase58(), 'with error', error);
            }
        }
    }

    async update(isUpdateMPG = true) {
        this.trg = await this.manifest.getTRG(this.traderRiskGroup);
        await this.updateRisk();
        if (isUpdateMPG) {
            this.marketProductGroup = new web3.PublicKey(this.trg.marketProductGroup.toBase58());
            this.mpg = await this.manifest.getMPG(this.marketProductGroup);
        }
        await this.updateMarkPrices(); // specifcally do this AFTER updating MPG
    }

    async connect(streamUpdatesCallback, initialUpdateCallback) {
        this.trgSlot = null;
        this.mpgSlot = null;
        this.riskSlot = null;
        this.markPricesSlot = null;
        await this.update();
        if (typeof initialUpdateCallback === 'function') {
            initialUpdateCallback();
        }
        if (!this.skipThingsThatRequireWalletConnection) {
            if (this.trg.owner.toBase58() !== this.manifest.fields.wallet.publicKey.toBase58()) {
                throw new Error('Expected this.trg.owner === given wallet pubkey. '+
                    'this.trg.owner: ' + this.trg.owner.toBase58() + '. wallet pubkey: ' + this.manifest.fields.wallet.publicKey.toBase58());
            }
        }
        if (typeof streamUpdatesCallback === 'function') {
            this.streamUpdates(streamUpdatesCallback);
        }
        await this.updateOrderbooks();
    }
}

function createDexProgram(provider: AnchorProvider) {
    return new Program(DEX_IDL, new web3.PublicKey(DEX_ID), provider);
}

function createInstrumentsProgram(provider: AnchorProvider) {
    return new Program(INSTRUMENTS_IDL, new web3.PublicKey(INSTRUMENTS_ID), provider);
}

function createRiskProgram(provider: AnchorProvider) {
    return new Program(RISK_IDL, new web3.PublicKey(RISK_ID), provider);
}

export default {
    bytesToString,
    Fractional,
    getManifest,
    getPriceDecimals,
    Manifest,
    productStatus,
    productToMeta,
    productToName,
    rpc2manifest, // exported for debugging purposes
    Trader,
    TraderUpdateType,
    BN,
    web3,
    ORACLE_TYPE_PYTH,
    INSTRUMENT_TYPE_RECURRING_CALL,
    INSTRUMENT_TYPE_EXPIRING_CALL,
    DEX_ID,
};
