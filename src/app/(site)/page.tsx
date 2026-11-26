import { Closing } from "@/components/landing/closing";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { NetworkNow } from "@/components/landing/network-now";
import { OnchainStatus } from "@/components/landing/onchain-status";
import { ProductPanel } from "@/components/landing/product-panel";
import { WhoFor } from "@/components/landing/who-for";
import { Disclosures, Faq, Features, Mechanics, Roadmap, RunANode, TokenSection } from "@/components/landing/sections";
import { TOKEN_COPY_OFF, tokenCopy, type TokenCopy } from "@/lib/token-copy";
import { tokenCopyState, tokenFlags } from "@/server/token-copy-state";

// Pons factory reads are refreshed at most once a minute.
export const revalidate = 60;

function Landing({ copy }: { copy: TokenCopy }) {
  return (
    <>
      <Hero noTokenFact={copy.heroNoToken} />
      <ProductPanel />
      <HowItWorks />
      <WhoFor noToken={copy.whoForNoToken} />
      <NetworkNow />
      <Features noToken={copy.bentoNoToken} />
      <Mechanics />
      <RunANode tokenLine={copy.runANodeToken} />
      <Faq />
      <Closing />
      {/* the token, contract reads and the long disclosures sit below the product */}
      <TokenSection need={copy.tokenFactNeed} feesToPot={copy.tokenFactFeesToPot} extra={copy.facts} />
      <OnchainStatus />
      <Roadmap />
      <Disclosures extra={copy.facts} />
    </>
  );
}

/** With a TOKEN_* flag on: the copy follows the flags (and the stake minimum read from the chain). */
async function LandingWithTokenCopy() {
  return <Landing copy={tokenCopy(await tokenCopyState())} />;
}

export default function Home() {
  // Token features (docs/token-features.md): the lines a TOKEN_* flag makes false follow the flags. With every flag off
  // the page renders synchronously with today's copy, exactly as before.
  const f = tokenFlags();
  return f.burns || f.holders || f.stakeGate || f.holderPage ? <LandingWithTokenCopy /> : <Landing copy={tokenCopy(TOKEN_COPY_OFF)} />;
}
