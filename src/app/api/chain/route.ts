import { chainSnapshot } from "@/lib/onchain";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Live chain reads for the site (network, Pons factory, reward contract, token). Never invents values. */
export async function GET() {
  const snap = await chainSnapshot();
  return Response.json(
    {
      configured: {
        rewardContract: config.rewardContract,
        token: config.tokenAddress,
        nodePayoutAsset: config.nodePayoutAsset,
        pairAsset: config.pairAsset,
        creatorTaxBps: config.creatorTaxBps,
        multisig: config.multisig,
      },
      ...snap,
    },
    { headers: { "cache-control": "public, max-age=10, stale-while-revalidate=20" } },
  );
}
