import _ from 'lodash';
import { Interface } from '@ethersproject/abi';
import { DeepReadonly } from 'ts-essentials';
import type { AbiItem } from 'web3-utils';
const erc20ABI = require('../../abi/erc20.json');
const nervePoolABIDefault = require('../../abi/nerve/nerve-pool.json');
import { Address, Log, Logger } from '../../types';
import { StatefulEventSubscriber } from '../../stateful-event-subscriber';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { NervePoolConfig, PoolState } from './types';
import { Adapters } from './config';
import { getManyPoolStates } from './getstate-multicall';
import { BlockHeader } from 'web3-eth';
import { biginterify } from './utils';
import { NervePoolMath } from './nerve-math';

export class NerveEventPool extends StatefulEventSubscriber<PoolState> {
  protected nervePoolMath: NervePoolMath;

  handlers: {
    [event: string]: (
      event: any,
      pool: PoolState,
      log: Log,
      blockHeader: BlockHeader,
    ) => PoolState;
  } = {};

  logDecoder: (log: Log) => any;

  addressesSubscribed: Address[];

  poolIface: Interface;

  lpTokenIface: Interface;

  isFetching = false;

  constructor(
    protected parentName: string,
    protected network: number,
    protected dexHelper: IDexHelper,
    logger: Logger,
    protected adapters = Adapters[network], // TODO: add any additional params required for event subscriber
    public poolConfig: NervePoolConfig,
    protected nervePoolABI: AbiItem[] = nervePoolABIDefault,
  ) {
    super(`${parentName}_${poolConfig.name}`, logger);
    this.nervePoolMath = new NervePoolMath(this.name, this.logger);

    this.logDecoder = (log: Log) => this.poolIface.parseLog(log);
    this.addressesSubscribed = [poolConfig.address];
    if (poolConfig.trackCoins) {
      this.addressesSubscribed = _.concat(
        this.poolCoins,
        this.addressesSubscribed,
      );
    }

    // Add handlers
    this.handlers['TokenSwap'] = this.handleTokenSwap.bind(this);
    this.handlers['AddLiquidity'] = this.handleAddLiquidity.bind(this);
    this.handlers['RemoveLiquidity'] = this.handleRemoveLiquidity.bind(this);
    this.handlers['RemoveLiquidityOne'] =
      this.handleRemoveLiquidityOne.bind(this);
    this.handlers['RemoveLiquidityImbalance'] =
      this.handleRemoveLiquidityImbalance.bind(this);
    this.handlers['NewAdminFee'] = this.handleNewAdminFee.bind(this);
    this.handlers['NewSwapFee'] = this.handleNewSwapFee.bind(this);
    this.handlers['NewDepositFee'] = this.handleNewDepositFee.bind(this);
    this.handlers['NewWithdrawFee'] = this.handleNewWithdrawFee.bind(this);
    this.handlers['RampA'] = this.handleRampA.bind(this);
    this.handlers['StopRampA'] = this.handleStopRampA.bind(this);

    this.poolIface = new Interface(JSON.stringify(this.nervePoolABI));
    this.lpTokenIface = new Interface(JSON.stringify(erc20ABI));

    this.logDecoder = (log: Log) => {
      if (
        this.poolConfig.trackCoins &&
        _.findIndex(
          this.poolCoins,
          c => c.toLowerCase() === log.address.toLowerCase(),
        ) != -1
      )
        return this.lpTokenIface.parseLog(log);

      return this.poolIface.parseLog(log);
    };
  }

  get poolAddress() {
    return this.poolConfig.address;
  }

  get lpTokenAddress() {
    return this.poolConfig.lpTokenAddress;
  }

  get poolCoins() {
    return this.poolConfig.coins;
  }

  get numTokens() {
    return this.poolCoins.length;
  }

  protected processLog(
    state: DeepReadonly<PoolState>,
    log: Readonly<Log>,
    blockHeader: Readonly<BlockHeader>,
  ): DeepReadonly<PoolState> | null {
    try {
      const event = this.logDecoder(log);
      const _state: PoolState = {
        initialA: biginterify(state.initialA),
        futureA: biginterify(state.futureA),
        initialATime: biginterify(state.initialATime),
        futureATime: biginterify(state.futureATime),
        swapFee: biginterify(state.swapFee),
        adminFee: biginterify(state.adminFee),
        defaultDepositFee: biginterify(state.defaultDepositFee),
        defaultWithdrawFee: biginterify(state.defaultWithdrawFee),
        lpToken_supply: biginterify(state.lpToken_supply),
        balances: state.balances.map(biginterify),
        tokenPrecisionMultipliers:
          state.tokenPrecisionMultipliers.map(biginterify),
        isValid: state.isValid,
      };
      if (event.name in this.handlers)
        return this.handlers[event.name](event, _state, log, blockHeader);
      return _state;
    } catch (e) {
      this.logger.error(`Error: unexpected error handling log:`, e);
    }
    return state;
  }

  async setup(blockNumber: number, poolState: PoolState | null = null) {
    if (!poolState) poolState = await this.generateState(blockNumber);
    if (blockNumber) this.setState(poolState, blockNumber);
  }

  async generateState(
    blockNumber: number | 'latest' = 'latest',
  ): Promise<Readonly<PoolState>> {
    return (
      await getManyPoolStates([this], this.dexHelper.multiContract, blockNumber)
    )[0];
  }

  handleNewAdminFee(event: any, state: PoolState) {
    state.adminFee = biginterify(event.args.newAdminFee);
    return state;
  }

  handleNewSwapFee(event: any, state: PoolState) {
    state.swapFee = biginterify(event.args.newSwapFee);
    return state;
  }

  handleNewDepositFee(event: any, state: PoolState) {
    state.defaultDepositFee = biginterify(event.args.newDepositFee);
    return state;
  }

  handleNewWithdrawFee(event: any, state: PoolState) {
    state.defaultWithdrawFee = biginterify(event.args.newWithdrawFee);
    return state;
  }

  handleRampA(event: any, state: PoolState) {
    state.initialA = biginterify(event.args.oldA);
    state.futureA = biginterify(event.args.newA);
    state.initialATime = biginterify(event.args.initialTime);
    state.futureATime = biginterify(event.args.futureTime);
    return state;
  }

  handleStopRampA(event: any, state: PoolState) {
    const finalA = biginterify(event.args.currentA);
    const finalTime = biginterify(event.args.time);

    state.initialA = finalA;
    state.futureA = finalA;
    state.initialATime = finalTime;
    state.futureATime = finalTime;
    return state;
  }

  handleTokenSwap(
    event: any,
    state: PoolState,
    _2: Log,
    blockHeader: BlockHeader,
  ) {
    const blockTimestamp = biginterify(blockHeader.timestamp);

    const transferredDx = biginterify(event.args.tokensSold);
    const dyEvent = biginterify(event.args.tokensBought);
    const tokenIndexFrom = event.args.soldId.toNumber();
    const tokenIndexTo = event.args.boughtId.toNumber();

    const swap = this.nervePoolMath.calculateSwap(
      state,
      tokenIndexFrom,
      tokenIndexTo,
      transferredDx,
      blockTimestamp,
    );

    if (swap === undefined) {
      state.isValid = false;
      return state;
    }

    const { dy, dyFee } = swap;

    const dyAdminFee =
      (dyFee * state.adminFee) /
      this.nervePoolMath.FEE_DENOMINATOR /
      state.tokenPrecisionMultipliers[tokenIndexFrom];

    state.balances[tokenIndexFrom] += transferredDx;
    state.balances[tokenIndexTo] -= dy - dyAdminFee;

    if (dyEvent !== dy) {
      this.logger.error(
        `For ${this.parentName}_${this.poolConfig.name} _calculateSwap value ${dy} is not equal to ${dyEvent} event value`,
      );
      state.isValid = false;
    }

    return state;
  }

  handleAddLiquidity(event: any, state: PoolState) {
    const tokenAmounts = event.args.tokenAmounts.map(biginterify) as bigint[];
    const fees = event.args.fees.map(biginterify) as bigint[];
    const lpTokenSupply = biginterify(event.args.lpTokenSupply);

    state.lpToken_supply = lpTokenSupply;
    for (const [i, tokenAmount] of tokenAmounts.entries()) {
      // We receive the real transferred amount. No need to check it
      state.balances[i] += tokenAmount;
      state.balances[i] -=
        (fees[i] * state.adminFee) / this.nervePoolMath.FEE_DENOMINATOR;
    }
    return state;
  }

  handleRemoveLiquidity(event: any, state: PoolState) {
    const tokenAmounts = event.args.tokenAmounts.map(biginterify) as bigint[];
    const lpTokenSupply = biginterify(event.args.lpTokenSupply);

    state.lpToken_supply = lpTokenSupply;
    for (const [i, tokenAmount] of tokenAmounts.entries()) {
      // We receive the real transferred amount. No need to check it
      state.balances[i] -= tokenAmount;
    }
  }

  handleRemoveLiquidityOne(
    event: any,
    state: PoolState,
    _2: Log,
    blockHeader: BlockHeader,
  ) {
    // To calculate remove liquidity one, we need to calculate the user fee.
    // It depends on the time when user deposited assets. That info can be obtained
    // by onchain call, but here there is no point of doing this.
    // Therefore we just invalidate our state so that next state request will generate new one

    state.isValid = false;
    return state;

    // It was original implementation before I knew about the problem
    // I will keep it till PR review. If we stick to this solution, I will
    // remove this code.

    // const blockTimestamp = biginterify(blockHeader.timestamp);
    // const lpTokenAmount = biginterify(event.args.lpTokenAmount);
    // const tokenIndex = event.args.boughtId.toNumber();
    // const dyEvent = biginterify(event.args.tokensBought);

    // const { dy, dyFee } = this.nervePoolMath.calculateWithdrawOneToken(
    //   state,
    //   lpTokenAmount,
    //   tokenIndex,
    //   blockTimestamp,
    // );
    // // self.balances[tokenIndex] = self.balances[tokenIndex].sub(
    // //    dy.add(dyFee.mul(self.adminFee).div(FEE_DENOMINATOR)));
    // state.balances[tokenIndex] -=
    //   dy + (dyFee * state.adminFee) / this.nervePoolMath.FEE_DENOMINATOR;

    // state.lpToken_supply -= lpTokenAmount;

    // // Check calculations correctness
    // if (dyEvent !== dy) {
    //   this.logger.error(
    //     `For ${this.parentName}_${
    //       this.poolConfig.name
    //     } _calculateWithdrawOneToken value ${stringify(
    //       dy,
    //     )} is not equal to ${stringify(dyEvent)} event value`,
    //   );
    //   state.isValid = false;
    // }

    // return state;
  }

  handleRemoveLiquidityImbalance(event: any, state: PoolState) {
    const tokenAmounts = event.args.tokenAmounts.map(biginterify) as bigint[];
    const fees = event.args.fees.map(biginterify) as bigint[];
    const lpTokenSupply = biginterify(event.args.lpTokenSupply);

    state.lpToken_supply = lpTokenSupply;
    for (const [i, tokenAmount] of tokenAmounts.entries()) {
      state.balances[i] -= tokenAmount;
      state.balances[i] -=
        (fees[i] * state.adminFee) / this.nervePoolMath.FEE_DENOMINATOR;
    }

    return state;
  }
}