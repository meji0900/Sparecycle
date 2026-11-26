import type { Metadata } from "next";
import Link from "next/link";
import { C, Defs, DocsHeader, DocsNext, DocsSection, Ext, Note, Step, Steps } from "@/components/docs/docs-ui";
import { CodeBlock } from "@/components/ui/code-block";
import { ADDR, explorerAddressUrl } from "@/lib/addresses";
import { MAINNET } from "@/lib/proof";
import { repoFile, siteOrigin } from "@/lib/site";
import { POLICY } from "@/server/env";

export const metadata: Metadata = {
  title: "Billing",
  description:
    "How paying for Sparecycle jobs works: deposit into the payments contract, what is held, when you are charged (only when two results match) and how to withdraw.",
};

export default function BillingPage() {
  const epochHours = MAINNET.epochLengthSeconds / 3600;
  const ttlHours = POLICY.jobTtlSeconds / 3600;
  return (
    <>
      <DocsHeader eyebrow="Reference" title="Billing">
        <p>
          Paid jobs draw on a balance you keep in the{" "}
          <Ext href={explorerAddressUrl(ADDR.payments)}>SparecycleJobPayments</Ext> contract. Your balance stays in that
          contract, not in a server wallet, and only your wallet can withdraw it. You are charged only for jobs whose two results
          match.
        </p>
      </DocsHeader>

      <DocsSection id="deposit" title="Deposit">
        <p>
          On the <Link href="/jobs" className="link">Jobs page</Link>, connect your wallet and choose Deposit. That calls{" "}
          <C>deposit()</C> on the payments contract with the ETH you choose; a plain ETH transfer to the contract does the same.
          The contract has no owner and no admin function, so nobody else can move your balance.
        </p>
      </DocsSection>

      <DocsSection id="balance" title="Your balance, in four figures">
        <Defs
          items={[
            ["Balance", "What the contract holds for you."],
            ["Held for running jobs", "The price of your jobs that have no verdict yet. Nothing has moved on-chain for them."],
            ["Pending withdrawal", "An amount you asked to withdraw. It can no longer pay for new jobs."],
            ["Available for new jobs", "Balance minus what is held minus a pending withdrawal."],
          ]}
        />
        <p>The Jobs page shows all four. Scripts can read them from the API:</p>
        <CodeBlock label="Terminal" code={`curl -s "${siteOrigin()}/api/v1/payments/account?address=0xYOUR_WALLET"`} />
      </DocsSection>

      <DocsSection id="charges" title="When you are charged">
        <ul className="list-disc space-y-2 pl-5 marker:text-faint">
          <li>The price is shown before you sign. Signing a job moves nothing on-chain; the price is only held.</li>
          <li>
            When the two results match (<C>agreed</C>), the job is charged at the end of the epoch, once every {epochHours} hours,
            together with the epoch&apos;s other matched jobs.
          </li>
          <li>
            When they do not match, when the safety checker rejects an image, or when there is no verdict within {ttlHours} hours,
            the job is <span className="text-text">not charged</span>. The hold is released and nothing leaves your balance.
          </li>
          <li>
            A charge sends 95% into the open epoch&apos;s node pot and 5% to the treasury Safe. The pot is shared by all matched
            work of that epoch, by work units, not paid to the two nodes of your job in particular. The 5% is computed on each
            epoch&apos;s total and rounded down, so a per-job share of it is approximate.
          </li>
        </ul>
        <Note title="What is public">
          Every charge is on-chain: the <C>CustomerCharged</C> event shows your wallet and the amount per epoch, and the
          epoch&apos;s charge list (<C>GET /api/v1/epochs/&#123;id&#125;/charges</C>) lists job ids, payers and prices.
        </Note>
      </DocsSection>

      <DocsSection id="withdraw" title="Withdraw">
        <p>
          You can start a withdrawal at any time. It completes after a lock, so that jobs you already ran can still be charged.
        </p>
        <Steps>
          <Step n={1} title="Start the withdrawal">
            <p>
              Request a withdrawal on the Jobs page, or call <C>requestWithdraw(amount)</C>. From then on that amount is no
              longer available for new jobs.
            </p>
          </Step>
          <Step n={2} title="Wait for the lock to end">
            <p>
              The withdrawal unlocks once the reward contract has closed the epoch you asked in and the next one, or two days
              after your request if epochs stop closing. Depending on when in the epoch you start, that is one to two epoch
              closes. The Jobs page shows when it is ready; on-chain it is <C>canWithdraw(yourWallet)</C>.
            </p>
          </Step>
          <Step n={3} title="Complete it">
            <p>
              Complete it on the Jobs page, or call <C>withdraw()</C>. It pays the amount you asked for, or your balance if that
              is now lower (jobs charged in the meantime come off first). Cancelling (<C>cancelWithdraw()</C>) drops a request
              you no longer want.
            </p>
          </Step>
        </Steps>
      </DocsSection>

      <DocsSection id="spend-limit" title="Spend limit">
        <p>
          You can cap what may be charged to you per epoch with <C>setSpendLimit(limit)</C> (0 removes the cap). The contract
          enforces it, so it holds even if the scheduler key were misused. A matched job over your limit is charged at a later
          epoch close.
        </p>
      </DocsSection>

      <DocsSection id="free" title="Free trial jobs">
        <p>Free trial jobs are never charged and need no balance. Their work shares the same node pot as paid work.</p>
        <p className="text-sm">
          Contract source and tests: <Ext href={repoFile("contracts/src/SparecycleJobPayments.sol")}>SparecycleJobPayments.sol</Ext>.
        </p>
      </DocsSection>

      <DocsNext
        links={[
          { href: "/docs/first-job", title: "Your first job", description: "Deposit and submit." },
          { href: "/docs/contracts", title: "Contracts and keys", description: "Addresses and source verification." },
        ]}
      />
    </>
  );
}
