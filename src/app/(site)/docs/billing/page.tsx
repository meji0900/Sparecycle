import type { Metadata } from "next";
import Link from "next/link";
import { C, Defs, DocsHeader, DocsNext, DocsSection, Ext, Note, Step, Steps } from "@/components/docs/docs-ui";
import { CodeBlock } from "@/components/ui/code-block";
import { ADDR, explorerAddressUrl, TOKEN_CONTRACTS, UNISWAP_V4 } from "@/lib/addresses";
import { ROBINHOOD_PUBLIC_RPC } from "@/lib/chain";
import { MAINNET } from "@/lib/proof";
import { MAX_ROUNDS, PICKUP_TIMEOUT_SECONDS } from "@/lib/rounds";
import { repoFile, siteOrigin } from "@/lib/site";
import { POLICY, serverEnv } from "@/server/env";

export const metadata: Metadata = {
  title: "Billing",
  description:
    "How paying for Sparecycle jobs works: deposit into the payments contract, what is held, when you are charged (only when two results match), job receipts you can check against the chain, and how to withdraw.",
};

export default function BillingPage() {
  const epochHours = MAINNET.epochLengthSeconds / 3600;
  const ttlHours = POLICY.jobTtlSeconds / 3600;
  const roundMinutes = (PICKUP_TIMEOUT_SECONDS + POLICY.taskLeaseSeconds) / 60;
  // SparecycleJobPaymentsV2: documented here once the scheduler runs it (TOKEN_PAYMENTS_V2 with its address).
  const v2 = serverEnv.tokenPaymentsV2() ? TOKEN_CONTRACTS.jobPaymentsV2 : null;
  const hookCut = (UNISWAP_V4.spareEthPoolHookCutBps / 100).toFixed(2);
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
            When the two results do not match, or the two nodes give no verdict within {roundMinutes} minutes of the first one
            starting, the job is <span className="text-text">checked again on another pair</span>: two nodes whose owner wallets
            and GPUs took no part in it before, if two such nodes are registered with the network. That happens at most{" "}
            {MAX_ROUNDS - 1} times ({MAX_ROUNDS} pairs in all), and only the last pair&apos;s verdict counts. Without such a pair
            the mismatch is final at once. Meanwhile the job shows &quot;Re-checking on another pair (round 2 of {MAX_ROUNDS})&quot;,
            the price stays held and nothing is charged. Every pair runs inside the same {ttlHours}-hour limit; a new pair starts
            only while a full {roundMinutes} minutes are still left of it.
          </li>
          <li>
            When no pair&apos;s results match, when the safety checker rejects an image (never checked again), or when there is no
            verdict within {ttlHours} hours, the job is <span className="text-text">not charged</span>. The hold is released and
            nothing leaves your balance.
          </li>
          <li>
            A charge sends 95% into the open epoch&apos;s node pot and 5% to the treasury Safe. The pot is shared by all matched
            work of that epoch, by work units, not paid to the two nodes of your job in particular. The 5% is computed on each
            epoch&apos;s total and rounded down, so a per-job share of it is approximate.
          </li>
        </ul>
        <Note title="What is public">
          Every charge is on-chain: the <C>CustomerCharged</C> event shows your wallet and the amount per epoch. The epoch&apos;s
          charge (<C>GET /api/v1/epochs/&#123;id&#125;/charges</C>) shows each wallet&apos;s total and the leaves of the jobs tree
          below, not job ids or prices. Every leaf includes a random salt that only your receipt holds, so nobody can link your
          wallet to a job from the public leaves. Charge lists from before job receipts list job ids, payers and prices.
        </Note>
      </DocsSection>

      <DocsSection id="receipts" title="Job receipts">
        <p>
          Every paid job also gets a receipt, next to its invoice on the <Link href="/jobs" className="link">Jobs page</Link> and in
          the playground. It appears as soon as the two results are compared and stays{" "}
          <span className="text-text">provisional</span> until the epoch&apos;s charge is confirmed on-chain; then it is{" "}
          <span className="text-text">sealed</span>.
        </p>
        <ul className="list-disc space-y-2 pl-5 marker:text-faint">
          <li>
            A receipt holds the job id, your wallet, the price, whether the results matched, whether you were charged, the hash of
            the output, the signed statements (EIP-712) of both nodes about the result each of them sent, and the random salt of
            your job&apos;s leaf.
          </li>
          <li>
            At each epoch close that charges at least one job, the scheduler builds a Merkle tree over every paid job settled since
            the last charge: charged, not charged and unpaid. Its root goes on-chain as the <C>listHash</C> of the payments
            contract&apos;s <C>Charged</C> event. A sealed receipt carries your job&apos;s leaf and the proof that leads to that root.
          </li>
          <li>
            <span className="text-text">Verify in this browser</span> recomputes the leaf from the receipt, follows the proof and reads
            the <C>Charged</C> event of the charge transaction from Robinhood Chain&apos;s public RPC (<C>{ROBINHOOD_PUBLIC_RPC}</C>),
            not through Sparecycle. Changing any field of the receipt makes the check fail.
          </li>
          <li>
            Save the receipt as a JSON file. <span className="text-text">Check a job receipt</span> on the Jobs page checks a saved
            file the same way, also while the Sparecycle API is unreachable. Keep the file private: its salt is what links your
            wallet to your job&apos;s public leaf.
          </li>
        </ul>
        <Note title="Which root is checked">
          The epoch&apos;s payout Merkle root, the one node owners claim from, covers node payouts: one leaf per node owner. Jobs and
          payers are not in it. A job receipt is checked against the jobs root in the <C>Charged</C> event instead.
        </Note>
        <Note title="An epoch without a charge">
          If an epoch close charges no job, the contract emits no <C>Charged</C> event, so there is no on-chain anchor for that
          epoch. Receipts of jobs that were not charged then say &ldquo;no on-chain anchor for this epoch&rdquo;, which is not a failed
          check. They go into the jobs root of the next epoch that charges a job.
        </Note>
        <Note tone="warn" title="If the public RPC does not load">
          Some internet providers, including many in Indonesia, block Robinhood Chain&apos;s public RPC by DNS. The check then says
          so and lets you paste another RPC URL of your choice. It never falls back to Sparecycle&apos;s own relay.
        </Note>
        <p>
          What a passing check shows: your job&apos;s line (job, wallet, price, verdict, charge status, output hash) is in the root
          committed on-chain with that charge. It does not show that the nodes computed the output correctly; the node signatures
          show which node keys reported the results. Over the API, with the job&apos;s read secret or a session of the paying wallet:
        </p>
        <CodeBlock label="Terminal" code={`curl -s -H "Authorization: Bearer READ_SECRET" ${siteOrigin()}/api/v1/jobs/JOB_ID/receipt`} />
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

      {v2 ? (
        <DocsSection id="v2" title="The V2 payments contract: credits and SPARE">
          <p>
            Paid jobs can also be paid from <Ext href={explorerAddressUrl(v2)}>SparecycleJobPaymentsV2</Ext>. New deposits on the{" "}
            <Link href="/jobs" className="link">Jobs page</Link> go there. A balance you already hold in the first payments contract
            (V1) stays usable for jobs and can be withdrawn any time, as above. A job is paid from one contract only, never split:
            from V2 when your V2 balance covers it, otherwise from V1. Your job&apos;s signed message names the contract it is paid on.
          </p>
          <Defs
            items={[
              ["Deposits", "ETH you put in (deposit(), or someone else's depositFor(you)). Only your wallet can withdraw it, with the same two-step withdrawal."],
              [
                "Credits",
                "ETH a holder claimed from the holder pool in credit mode. Credits pay for jobs before deposits do. They can pay for jobs only and can never be withdrawn.",
              ],
              ["SPARE balance", "SPARE you put in: approve the amount, then depositSpare(amount). Withdraw it with requestWithdrawSpare, then withdrawSpare, after the same lock."],
            ]}
          />
          <ul className="list-disc space-y-2 pl-5 marker:text-faint">
            <li>
              <span className="text-text">Paying with SPARE, no discount.</span> A SPARE-paid job costs its ETH price in SPARE at the
              epoch&apos;s SPARE price, rounded up. On the Jobs page you choose per job: ETH balance or SPARE balance. The SPARE amount
              shown when you submit uses the last accepted price; the amount taken uses the price of the epoch that charges the job.
            </li>
            <li>
              <span className="text-text">The epoch price.</span> Once per epoch the scheduler posts the price of the SPARE/ETH Uniswap v4
              pool. The contract accepts it only within 20% of the last accepted price; otherwise SPARE charges pause for that epoch and
              ETH charges go on. The treasury Safe sets the first reference price; until it does, SPARE payments are closed.
            </li>
            <li>
              <span className="text-text">The {hookCut}% hook cut.</span> The SPARE taken is sold for ETH in the same transaction, so the
              node pot still gets 95% of the job&apos;s ETH price. The pool&apos;s Pons hook takes {hookCut}% of every sale (1.00% hook fee
              and a 1.90% creator tax that goes to the team wallet). That cut is paid out of the 5% protocol share: on a SPARE-paid job
              the treasury keeps only what the sale brings in above the pot&apos;s 95% (about 2%) and the holder pool gets nothing from
              it. Your balance and the node pot do not pay it.
            </li>
            <li>
              <span className="text-text">Caps and waiting.</span> The treasury Safe sets a cap on SPARE-paid volume per epoch (in ETH
              value). A SPARE-paid job that cannot be charged at an epoch close (no reference price yet, the price paused, the cap
              reached, the sale would not fill within 4% of the posted price, or your SPARE balance does not cover it at that
              price) is never charged at another price: it waits for the next close, and its invoice says why. After 8 closes it is
              not charged at all.
            </li>
            <li>
              <span className="text-text">Spend limits.</span> <C>setSpendLimit</C> caps ETH-paid and SPARE-paid jobs together (SPARE
              ones at their ETH price); <C>setSpareSpendLimit</C> caps the SPARE taken per epoch.
            </li>
            <li>
              <span className="text-text">Where the 5% goes.</span> In V2 the 5% is split 3.5% treasury, 1.5% holder pool and 0%
              burn: the burn is postponed. Only the treasury Safe can change the split, and a change applies at least 4 epochs after
              it is proposed.
            </li>
            <li>
              <span className="text-text">Receipts.</span> While V2 is on, receipts are version 2: they also say which contract charged
              the job, whether ETH or SPARE paid, and for SPARE the price used and the SPARE taken. The browser check reads the
              matching <C>CustomerChargedSpare</C> event too. Saved version 1 receipts keep verifying.
            </li>
          </ul>
          <Note title="Not externally audited">
            SparecycleJobPaymentsV2, the holder pool, the burner and the Uniswap v4 swap adapter have had internal review and tests
            only. Like V1, V2 has no owner who can move your balance; the treasury Safe sets the split, the SPARE reference price,
            the price band, the slippage and the SPARE cap.
          </Note>
          <p className="text-sm">
            Contract source: <Ext href={repoFile("contracts/src/SparecycleJobPaymentsV2.sol")}>SparecycleJobPaymentsV2.sol</Ext>; design
            and decisions: <Ext href={repoFile("docs/contracts-v2.md")}>docs/contracts-v2.md</Ext>.
          </p>
        </DocsSection>
      ) : null}

      <DocsSection id="free" title="Free trial jobs">
        <p>
          Free trial jobs are never charged and need no balance. Their work shares the same node pot as paid work. They run on one
          pair only: a mismatch is final, with no re-check on another pair.
        </p>
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
