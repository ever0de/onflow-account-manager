import * as fcl from "@onflow/fcl";

import { signWithKey } from "../cadence/crypto";
import { Address, TxId } from "../types";

import { KeyPair } from "./types";

export const enum TxStatus {
  Unknown = 0,
  /**
   * Transaction Pending - Awaiting Finalization
   */
  Pending = 1,
  /**
   * Transaction Finalized - Awaiting Execution
   */
  Finalized = 2,
  /**
   * Transaction Executed - Awaiting Sealing
   */
  Executed = 3,
  /**
   * Transaction Sealed - Transaction Complete. At this point the transaction
   * result has been committed to the blockchain.
   */
  Sealed = 4,
  /**
   * Transaction Expired
   */
  Expired = 5,
}

export class Account {
  private static DEFAULT_SEQNUM: number = 0;

  private constructor(
    public readonly address: Address,
    private readonly keyPair: KeyPair,
    private _seqNum: number,
    private readonly _keyId?: number,
    private _txId?: TxId,
  ) {}

  public static async new(args: {
    address: Address;
    keyPair: KeyPair;
    keyId?: number;
    seqNum?: number;
  }): Promise<Account> {
    let seqNum = args.seqNum;
    if (!seqNum) {
      const account = await fcl.account(args.address);
      const key = account.keys[args.keyId ?? 0];

      seqNum = key?.sequenceNumber ?? Account.DEFAULT_SEQNUM;
    }

    return new Account(args.address, args.keyPair, seqNum, args.keyId);
  }

  public get keyId(): number {
    return this._keyId ?? 0;
  }

  public get seqNum(): number {
    const seqNum = this._seqNum;
    this._seqNum += 1;

    return seqNum;
  }

  public get txId(): string | undefined {
    return this._txId;
  }

  public set newTxId(newTxId: TxId) {
    this._txId = newTxId;
  }

  public stringify() {
    return `${this.address}[${this._seqNum}]`;
  }

  public async isAvailable(): Promise<boolean> {
    if (this.txId === undefined) {
      return true;
    }

    return (fcl.tx(this.txId).snapshot() as any).then(
      (tx: { status: number }) => {
        const isAvailable = tx.status >= TxStatus.Sealed;

        if (isAvailable) {
          this._txId = undefined;
        }

        return isAvailable;
      },
    );
  }

  /**
   * When creating a transaction, **`only the proposer`** must specify a sequence number.
   * Payers and authorizers are not required to.
   */
  public getCadenceAuth(args?: {
    isProposer: boolean;
  }): fcl.AuthorizationFunction {
    const { address, keyId, keyPair } = this;
    const seqNum = args?.isProposer ? this.seqNum : null;

    return (acct) => ({
      ...acct,
      addr: address,
      keyId,
      signingFunction: async (signable) => ({
        addr: address,
        keyId,
        signature: signWithKey(keyPair.private, signable.message),
      }),
      sequenceNum: seqNum,
    });
  }
}
