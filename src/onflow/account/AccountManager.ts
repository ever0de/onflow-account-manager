import * as fcl from "@onflow/fcl";
import * as t from "@onflow/types";
import * as fs from "fs";
import { join } from "path";
import rlp from "rlp";

import { delay } from "../../utils";
import { ec } from "../cadence/crypto";
import { createAccountCadence } from "../cadence/tx-constants";
import { Address, TxId } from "../types";

import { Account } from "./Account";
import { KeyPair } from "./types";

export class AccountManager {
  private readonly interval: number = 100;

  constructor(
    private readonly mainAccount: Account,
    private _accounts: Account[] = [],
    interval?: number,
  ) {
    if (interval) {
      this.interval = interval;
    }
  }

  public async getAccount(): Promise<Account> {
    for (const account of this._accounts) {
      const isAvailable = await account.isAvailable();

      if (isAvailable) {
        return account;
      }
    }

    const isAvailable = await this.mainAccount.isAvailable();
    if (!isAvailable) {
      await (fcl.tx(this.mainAccount.txId!).onceSealed() as any);
    }
    const newAccount = await this.createNewAccount();

    return newAccount;
  }

  public async mutate(
    args: Pick<fcl.MutateArgs, "cadence" | "args">,
  ): Promise<TxId> {
    const { cadence, args: mutateArgs } = args;

    const proposerAccount = await this.getAccount();

    const auth = proposerAccount.getCadenceAuth({ isProposer: true });
    const mainAuth = this.mainAccount.getCadenceAuth();

    const newTxId = await fcl.mutate({
      cadence,
      args: mutateArgs,
      proposer: auth,
      authorizations: [mainAuth],
      payer: mainAuth,
      // XXX: default value
      limit: 9999,
    });
    proposerAccount.newTxId = newTxId;

    await delay(this.interval);
    return newTxId;
  }

  private async createNewAccount(): Promise<Account> {
    const keys = this.generateKeyPair();
    const flowPublicKey = this.encodePublicKeyForFlow(keys.public);

    const mainAuth = this.mainAccount.getCadenceAuth();
    const newAddress = await createAccountTx({
      cadence: createAccountCadence,
      args: (arg) => [arg(flowPublicKey, t.String)],
      payer: mainAuth,
      authorizations: [mainAuth],
      proposer: mainAuth,
      limit: 9999,
    });

    const newAccount = await Account.new({
      address: newAddress,
      keyPair: keys,
      seqNum: 0,
    });
    this.pushAccount(newAccount);

    return newAccount;
  }

  private pushAccount(account: Account) {
    this._accounts.push(account);
  }

  private generateKeyPair(): KeyPair {
    const keyPair = ec.genKeyPair();

    return {
      public: keyPair.getPublic("hex").replace(/^04/, ""),
      private: keyPair.getPrivate("hex"),
    };
  }

  private encodePublicKeyForFlow(publicKey: string): string {
    const encoded = rlp.encode([
      // publicKey hex to binary
      Buffer.from(publicKey, "hex"),
      // P256 per https://github.com/onflow/flow/blob/master/docs/accounts-and-keys.md#supported-signature--hash-algorithms
      2,
      // SHA3-256 per https://github.com/onflow/flow/blob/master/docs/accounts-and-keys.md#supported-signature--hash-algorithms
      3,
      // give key full weight
      1000,
    ]);

    return Buffer.from(encoded).toString("hex");
  }
}

const createAccountTx = async (args: fcl.MutateArgs): Promise<Address> => {
  const txId = await fcl.mutate(args);

  const { events } = await fcl.tx<{ address: Address }>(txId).onceSealed();

  const accountAddedEvent = events.find(
    (event) => event.type === "flow.AccountCreated",
  );
  if (!accountAddedEvent) {
    throw new Error(`Failed created account transactions`);
  }

  const { address: newAddress } = accountAddedEvent.data;

  return newAddress;
};
