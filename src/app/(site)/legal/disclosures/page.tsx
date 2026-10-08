import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection, Placeholder } from "@/components/legal/legal-page";
import { ReviewStatus } from "@/components/legal/review-status";
import { Hex } from "@/components/ui/address";
import { config, tickerLabel } from "@/lib/config";
import { PONS, PONS_DOCS_URL } from "@/lib/pons";
import { FUNDING, paidJobsLive } from "@/lib/funding-copy";

export const metadata: Metadata = {
  title: "Disclosures",
  description:
    "Not advice, not a yield product, fees-only funding, a centralized scheduler, an untested fee-recipient path and Pons v2 unaudited as of 20 November 2026.",
};

export default function DisclosuresPage() {
  const ticker = config.ticker ? <span className="num text-text">{tickerLabel()}</span> : <Placeholder>[TICKER]</Placeholder>;
  const checked = config.factsCheckedOn;
  return (
    <LegalPage
      title="Disclosures"
      current="disclosures"
      status={
        <>
          <ReviewStatus url={config.links.tos} urlPlaceholder="[TOS_URL]" noun="terms" />
          <p className="mt-2">Facts about Pons v2 were checked on {checked}.</p>
        </>
      }
    >
      <LegalSection title="Not financial, legal, or tax advice">
        <p>
          Sparecycle is software: a website, a reward contract, and node tooling. It does not promise income, a token price, a
          number of jobs, or a number of nodes. Nothing here is an offer or solicitation to buy or sell {ticker} or any other
          asset. It is not a yield product and not a fixed return.
        </p>
      </LegalSection>

      <LegalSection title={`${config.ticker ? tickerLabel() : "The token"} can go to zero`}>
        <p>
          Pons launch tokens are volatile. Names and symbols are not unique. The only reliable identifier is the token address,
          which does not exist until launch{" "}
          {config.tokenAddress ? (
            <>
              (now <Hex value={config.tokenAddress} />)
            </>
          ) : (
            <>
              (<Placeholder>[TOKEN_ADDRESS]</Placeholder>, not launched yet)
            </>
          )}
          . Graduation means the curve sold out, not that the project is high quality. Reaching a locked Uniswap v4 pool does
          not protect holders from price collapse. The LP lock at graduation is Pons&apos;s mechanism, not a price floor. There
          is no team token allocation: the supply is minted to the Pons curve.
        </p>
      </LegalSection>

      <LegalSection title={`Pons v2 was unaudited as of ${checked}`}>
        <p>
          Official docs listed three reviews (SB Security, Dingbats, Pashov Audit Group) as in progress, and no report had
          closed. Treat the launchpad as unaudited until reports are published. An audit is not a guarantee. Official docs also
          said public launches were closed and that callers should check <span className="num text-text">canLaunch(address)</span>{" "}
          rather than assume; a same-day on-chain check found <span className="num text-text">launchEnabled() = true</span>.{" "}
          <span className="num text-text">canLaunch</span> is checked for the launching wallet immediately before any launch
          transaction. Sparecycle is not affiliated with or endorsed by Pons; read the{" "}
          <a href={PONS_DOCS_URL} className="link" target="_blank" rel="noreferrer">
            official Pons v2 docs
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection title="Fees may be too small to attract nodes">
        <p>
          Rewards track volume{paidJobsLive ? " and paid jobs" : ""}. {FUNDING.noTopUp} A quiet period means a small or empty pot,
          and an empty pot pays nothing.
        </p>
      </LegalSection>

      {paidJobsLive && config.jobPayments ? (
        <LegalSection title="Paid jobs and your balance">
          <p>
            Balances for paid jobs are held by the payments contract (<Hex value={config.jobPayments} />), not by any Sparecycle
            wallet. It has no owner and no admin functions. Only you can withdraw your balance: request it, then withdraw once
            the epoch you asked in and the next one have closed (up to about 12 hours), or after 2 days if epochs stop closing.
            The amount you asked to withdraw can&apos;t be spent on new jobs meanwhile.
          </p>
          <p>
            The scheduler charges a job only after two nodes agree on it, once per epoch, at the published price. 95% of each
            charge goes into the node reward pot and 5% to the treasury
            {config.treasury ? (
              <>
                {" "}
                (<Hex value={config.treasury} />)
              </>
            ) : null}
            , a Safe that needs two signatures to move funds. Both of its keys are currently held by the project owner. The
            scheduler key is trusted to charge only for verified jobs; every charge list is published at
            /api/v1/epochs/&#123;id&#125;/charges, and you can cap what it may charge you per epoch.
          </p>
        </LegalSection>
      ) : null}

      <LegalSection title="Job results and GPU software are not guaranteed">
        <p>
          Models can fail, disagree, or produce unusable output. Only jobs that pass the two-node check are eligible for
          payment, and even those payments depend on the pot. Job prompts and agreed results are not private.
        </p>
      </LegalSection>

      <LegalSection title="Legal status is not settled">
        <p>
          The legal status of the token and of a compute network is not settled. Counsel should review the launch, the public
          job-submission surface, and any geographic or terms-of-use rules (<Placeholder>[TOS_URL]</Placeholder>,{" "}
          <Placeholder>[LEGAL_REVIEW]</Placeholder>). No securities or geographic policy is stated here until counsel writes one.
        </p>
      </LegalSection>

      <section aria-labelledby="trust" className="space-y-4 rounded-l border border-amber/25 bg-amber-soft/40 p-6">
        <h2 id="trust" className="text-lg font-semibold tracking-[-0.01em] text-text">
          Trust assumptions
        </h2>
        <ul className="space-y-4 text-[15px] leading-relaxed text-muted">
          <li className="flex gap-3">
            <span aria-hidden className="mt-2.5 h-px w-3 shrink-0 bg-amber" />
            <span>
              <span className="text-text">The scheduler is centralized in this MVP.</span> One operator assigns jobs, compares
              results, closes each epoch and posts the Merkle root. It can err or misbehave. Cross-checking reduces bad job
              results; it does not make root posting trustless. The contract enforces only that a root reserves no more than the
              pot and that claims never exceed what a root reserved.
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="mt-2.5 h-px w-3 shrink-0 bg-amber" />
            <span>
              <span className="text-text">A contract as creatorFeeRecipient was untested.</span> Pons allows a contract to be
              the creator fee recipient by design, but that path was untested as of {checked}. The fallback is a multisig
              {config.multisig ? (
                <>
                  {" "}
                  (<Hex value={config.multisig} />)
                </>
              ) : (
                <>
                  {" "}
                  (<Placeholder>[MULTISIG_ADDRESS]</Placeholder>, not set yet)
                </>
              )}{" "}
              that claims fees from the Pons escrow and forwards them into the reward contract.
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="mt-2.5 h-px w-3 shrink-0 bg-amber" />
            <span>
              <span className="text-text">The contract owner can pause claims, not take the pot.</span> The owner{" "}
              {config.owner && config.multisig && config.owner.toLowerCase() === config.multisig.toLowerCase() ? (
                <>
                  is a multisig (<Hex value={config.owner} />). It
                </>
              ) : config.owner ? (
                <>
                  is a single wallet (<Hex value={config.owner} />), not a multisig, so one key controls these levers. It
                </>
              ) : (
                <>(<Placeholder>[OWNER_ADDRESS]</Placeholder>, not deployed yet)</>
              )}{" "}
              can pause and unpause claims, rotate the scheduler, and rescue a wrong token sent by mistake. It has no function
              to withdraw the payout asset, mint, or set the pot.
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="mt-2.5 h-px w-3 shrink-0 bg-amber" />
            <span>
              <span className="text-text">Pons v2 is external and was unaudited as of {checked}.</span> The bonding curve, fee
              escrow (<Hex value={PONS.feeEscrow} />) and liquidity lock are Pons contracts, outside this project&apos;s control.
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden className="mt-2.5 h-px w-3 shrink-0 bg-amber" />
            <span>
              <span className="text-text">The reward contract has its own tests, not an audit</span>, unless a report URL is
              published here.
            </span>
          </li>
        </ul>
      </section>

      <LegalSection title="Software notice">
        <p>The node client is adapted from MIT-licensed code; see NOTICE in the repository.</p>
        <p>
          Live reads are on the{" "}
          <Link href="/token" className="link">
            token page
          </Link>{" "}
          and the{" "}
          <Link href="/app" className="link">
            status page
          </Link>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
