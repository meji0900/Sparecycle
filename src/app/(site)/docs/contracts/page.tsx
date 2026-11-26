import type { Metadata } from "next";
import Link from "next/link";
import { AddressTable } from "@/components/docs/address-table";
import { C, DocsHeader, DocsNext, DocsSection, Ext, Note } from "@/components/docs/docs-ui";
import { CodeBlock } from "@/components/ui/code-block";
import { ADDR, ADDRESS_ROWS, MAINNET_CHAIN_ID, TESTNET_CHAIN_ID, explorerAddressUrl } from "@/lib/addresses";

export const metadata: Metadata = {
  title: "Contracts and keys",
  description:
    "Every Sparecycle contract and key on Robinhood Chain with a copy button, an explorer link and its source verification status, plus the Pons contracts it uses.",
};

const RPC = "https://rpc.mainnet.chain.robinhood.com";

export default function ContractsPage() {
  const mainnet = ADDRESS_ROWS.filter((r) => r.network === "mainnet");
  const ours = mainnet.filter((r) => r.kind === "contract" && r.by !== "pons");
  const keys = mainnet.filter((r) => r.kind === "key");
  const pons = mainnet.filter((r) => r.by === "pons");
  const testnet = ADDRESS_ROWS.filter((r) => r.network === "testnet");

  return (
    <>
      <DocsHeader eyebrow="Reference" title="Contracts and keys">
        <p>
          Every address Sparecycle uses on Robinhood Chain (chain id <span className="num">{MAINNET_CHAIN_ID}</span>). Each one
          copies in full and opens on the Blockscout explorer. Contracts show whether their published source matches the
          deployed bytecode, with the date that was checked.
        </p>
      </DocsHeader>

      <DocsSection id="contracts" title="Sparecycle contracts">
        <AddressTable rows={ours} label="Sparecycle contracts on mainnet" />
        <Note title="Who controls what">
          <p>
            SparecycleRewards has no withdraw function: its owner can pause claims, replace the scheduler key and return tokens
            sent by mistake, not take the pot. SparecycleJobPayments has no owner at all. The owner of SparecycleRewards is the
            treasury Safe, which needs 2 of its 3 signers; all three keys are currently held by the project owner, so it guards
            against one lost or leaked key, not against the project owner. More on{" "}
            <Link href="/proof" className="link">Proof</Link> and in the{" "}
            <Link href="/legal/disclosures" className="link">disclosures</Link>.
          </p>
        </Note>
      </DocsSection>

      <DocsSection id="keys" title="Keys (not contracts)">
        <p>Wallets the project uses. They hold gas or receive funds; none of them can move a customer&apos;s balance.</p>
        <AddressTable rows={keys} label="Sparecycle keys on mainnet" />
      </DocsSection>

      <DocsSection id="pons" title="Pons contracts (not Sparecycle's)">
        <p>
          The tokens were launched on Pons v2. These contracts are Pons&apos;s: Sparecycle uses them but did not write them and
          cannot change them. Sparecycle is not affiliated with Pons.
        </p>
        <AddressTable rows={pons} label="Pons contracts on mainnet" />
      </DocsSection>

      <DocsSection id="testnet" title={`Testnet (${TESTNET_CHAIN_ID})`}>
        <p>
          The full loop was first run on Robinhood Chain testnet. These addresses hold no real value and open on the testnet
          explorer.
        </p>
        <AddressTable rows={testnet} label="Testnet addresses" />
      </DocsSection>

      <DocsSection id="check" title="Check it yourself">
        <p>Read the live values straight from the chain with Foundry&apos;s <C>cast</C>, without trusting this page:</p>
        <CodeBlock
          label="Terminal"
          code={[
            `cast call ${ADDR.rewards} "owner()(address)" --rpc-url ${RPC}`,
            `cast call ${ADDR.rewards} "scheduler()(address)" --rpc-url ${RPC}`,
            `cast call ${ADDR.payments} "treasury()(address)" --rpc-url ${RPC}`,
            `cast call ${ADDR.treasurySafe} "getThreshold()(uint256)" --rpc-url ${RPC}`,
          ].join("\n")}
        />
        <p>
          Or open the contracts on Blockscout: <Ext href={explorerAddressUrl(ADDR.rewards)}>SparecycleRewards</Ext>,{" "}
          <Ext href={explorerAddressUrl(ADDR.payments)}>SparecycleJobPayments</Ext>,{" "}
          <Ext href={explorerAddressUrl(ADDR.treasurySafe)}>treasury Safe</Ext>.
        </p>
      </DocsSection>

      <DocsNext
        links={[
          { href: "/docs/billing", title: "Billing", description: "How the payments contract handles your balance." },
          { href: "/proof", title: "Proof", description: "Live reads compared with the record, and every setup transaction." },
        ]}
      />
    </>
  );
}
