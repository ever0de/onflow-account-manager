import * as fcl from "@onflow/fcl";
import * as t from "@onflow/types";
import { ec as EC } from "elliptic";
import * as fs from "fs";
import { join } from "path";
import rlp from "rlp";

import { delay } from "../../utils";
import { createAccountCadence } from "../cadence/tx-constants";
import { Address, TxId } from "../types";

import { Account } from "./Account";
import { KeyPair } from "./types";

export class AccountManager {
  private readonly interval: number = 100;
  private ec: EC = new EC("p256");

  constructor(
    private readonly mainAccount: Account,
    private _accounts: Account[],
    interval?: number,
  ) {
    if (interval) {
      this.interval = interval;
    }
  }

  public static async fromJsonFile(
    mainAccount: Account,
    _path?: string,
  ): Promise<AccountManager> {
    const path = _path ?? ACCOUNT_JSON_PATH;

    const buffer = fs.readFileSync(path);
    const text = buffer.toString("utf8");

    const accounts: Account[] = await Promise.all(
      JSON.parse(text).map((account: any) => Account.new(account)),
    );
    const manager = new AccountManager(mainAccount, accounts);

    return manager;
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
    console.log(proposerAccount.stringify());

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
    console.log(`Sealing... ${newTxId}`);
    proposerAccount.newTxId = newTxId;

    this.save();
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
    console.log(`CREATE NEW ADDRESS: ${newAddress}`);

    const newAccount = await Account.new({
      address: newAddress,
      keyPair: keys,
      seqNum: 0,
    });
    this.pushAccount(newAccount);

    return newAccount;
  }

  public save() {
    fs.writeFileSync(ACCOUNT_JSON_PATH, JSON.stringify(this._accounts));
  }

  private pushAccount(account: Account) {
    this._accounts.push(account);
    this.save();
  }

  private generateKeyPair(): KeyPair {
    const keyPair = this.ec.genKeyPair();

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

export const ACCOUNT_JSON_PATH = join(__dirname, "../../../data/accounts.json");

const createAccountTx = async (args: fcl.MutateArgs): Promise<Address> => {
  const txId = await fcl.mutate(args);
  console.log(`CREATE Account TX ID: ${txId}`);

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
