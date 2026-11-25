import { Closing } from "@/components/landing/closing";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { NetworkNow } from "@/components/landing/network-now";
import { OnchainStatus } from "@/components/landing/onchain-status";
import { ProductPanel } from "@/components/landing/product-panel";
import { WhoFor } from "@/components/landing/who-for";
import { Disclosures, Faq, Features, Mechanics, Roadmap, RunANode, TokenSection } from "@/components/landing/sections";

// Pons factory reads are refreshed at most once a minute.
export const revalidate = 60;

export default function Home() {
  return (
    <>
      <Hero />
      <ProductPanel />
      <HowItWorks />
      <WhoFor />
      <NetworkNow />
      <Features />
      <Mechanics />
      <RunANode />
      <Faq />
      <Closing />
      {/* the token, contract reads and the long disclosures sit below the product */}
      <TokenSection />
      <OnchainStatus />
      <Roadmap />
      <Disclosures />
    </>
  );
}
