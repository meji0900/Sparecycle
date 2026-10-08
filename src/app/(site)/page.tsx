import { Closing } from "@/components/landing/closing";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { NetworkNow } from "@/components/landing/network-now";
import { OnchainStatus } from "@/components/landing/onchain-status";
import { Disclosures, Faq, Features, Mechanics, Roadmap, RunANode, TokenSection } from "@/components/landing/sections";
import { tickerLabel } from "@/lib/config";

// Pons factory reads are refreshed at most once a minute.
export const revalidate = 60;

export default function Home() {
  return (
    <>
      <Hero ticker={tickerLabel()} />
      <NetworkNow />
      <HowItWorks />
      <Features />
      <Mechanics />
      <OnchainStatus />
      <RunANode />
      <TokenSection />
      <Roadmap />
      <Faq />
      <Closing />
      <Disclosures />
    </>
  );
}
