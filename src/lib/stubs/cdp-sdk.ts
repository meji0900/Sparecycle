// Build stub. @wagmi/connectors → @base-org/account imports the Coinbase CDP server SDK for a
// subscription feature this app never uses; the real package pulls optional x402 modules that are
// not installed. The Base Account wallet is not offered in our wallet list.
export class CdpClient {
  constructor() {
    throw new Error("Coinbase CDP SDK is not bundled in Sparecycle");
  }
}
const stub = { CdpClient };
export default stub;
