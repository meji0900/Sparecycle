// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {UniswapV4SpareAdapter as Adapter} from "../../src/adapters/UniswapV4SpareAdapter.sol";
import {PoolKey} from "../../src/interfaces/IUniswapV4Minimal.sol";

interface IStateViewFork {
    function poolManager() external view returns (address);
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
    function getLiquidity(bytes32 poolId) external view returns (uint128);
}

interface IV4QuoterFork {
    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function poolManager() external view returns (address);
    function quoteExactInputSingle(QuoteExactSingleParams memory params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);
}

/// @dev PonsV2MemeHook.LaunchInfo (Sourcify-verified source); all fields static, so the public getter's return
///      tuple has the same encoding as this struct.
struct PonsLaunchInfo {
    bool registered;
    bool memecoinIsCurrency0;
    address memecoin;
    address quoteToken;
    address creator;
    address buybackCreatorRecipient;
    address protocolFeeRecipient;
    uint16 creatorTaxBps;
    uint16 protocolFeeShareBps;
    uint16 buybackBurnBps;
    uint16 hookFeeBps;
    uint16 maxInternalPriceImpactBps;
    bool buybackEnabled;
}

interface IPonsMemeHookFork {
    function poolManager() external view returns (address);
    function launches(bytes32 poolId) external view returns (PonsLaunchInfo memory);
}

interface IUniversalRouterFork {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @dev v4-periphery IV4Router.ExactInputSingleParams as built into both routers on chain 4663 (Sourcify sources).
struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}

/// @notice The live Uniswap v4 SPARE/ETH pool on Robinhood Chain mainnet (4663), shared by the V4 fork suites. Every
///         address here was read on-chain and matches Uniswap's deployment list for chain 4663 where Uniswap lists
///         it (docs/uniswap-v4-adapter.md). Nothing is broadcast: forks simulate locally.
abstract contract V4ForkBase is Test {
    /// Uniswap v4 (developers.uniswap.org/docs/protocols/v4/deployments, "Robinhood Chain: 4663", and
    /// github.com/Uniswap/contracts deployments/4663.json; code present and Sourcify-verified).
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address internal constant V4_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    /// Universal Router 2.1.2: `latest.UniversalRouter` in deployments/4663.json. The docs also list the earlier
    /// router below; both are v4-periphery builds whose ExactInputSingleParams carry `minHopPriceX36`.
    address internal constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address internal constant UNIVERSAL_ROUTER_PREVIOUS = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    /// SPARE (ADDR.spareToken) and the Pons v2 meme hook (PONS.memeHook, docs.ponsfamily.com/v2).
    address internal constant SPARE = 0x012D695B94377E0c7b9EdEE3d824259BaA37cf3A;
    address internal constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;
    /// The pool: PoolManager Initialize event, block 123,451,046, tx 0x8d9b6662…74b5.
    uint24 internal constant FEE = 0;
    int24 internal constant TICK_SPACING = 200;
    bytes32 internal constant POOL_ID = 0x6c779d26cc59abb9f22d348257ee013b66d2a5f0d9dcf1bb9fa9338874eab1bd;
    /// The hook's cut of every swap's unspecified (output, for exact input) side: hookFeeBps + creatorTaxBps.
    uint256 internal constant HOOK_CUT_BPS = 290;

    IERC20 internal spare = IERC20(SPARE);
    Adapter internal adapter;

    function _forkOrSkip() internal returns (bool) {
        if (vm.envOr("FORK_TESTS", uint256(0)) != 1) {
            vm.skip(true, "set FORK_TESTS=1 to run");
            return false;
        }
        string memory rpc = vm.envOr("FORK_RPC_URL", string("robinhood"));
        uint256 blockNo = vm.envOr("FORK_BLOCK", uint256(0));
        if (blockNo != 0) {
            try vm.createSelectFork(rpc, blockNo) {}
            catch {
                vm.skip(true, "fork RPC unreachable");
                return false;
            }
        } else {
            try vm.createSelectFork(rpc) {}
            catch {
                vm.skip(true, "fork RPC unreachable");
                return false;
            }
        }
        try this.probeStorage() {}
        catch {
            vm.skip(true, "fork RPC refuses storage reads (eth_getStorageAt): use FORK_RPC_URL=<full RPC>");
            return false;
        }
        return true;
    }

    /// @dev External so setUp can catch a failed remote storage read.
    function probeStorage() external view returns (bytes32) {
        return vm.load(POOL_MANAGER, bytes32(0));
    }

    function _key() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: address(0), currency1: SPARE, fee: FEE, tickSpacing: TICK_SPACING, hooks: HOOK});
    }

    function _deployAdapter() internal {
        adapter = new Adapter(POOL_MANAGER, SPARE, FEE, TICK_SPACING, HOOK);
    }

    function _sqrtP() internal view returns (uint160 s) {
        (s,,,) = IStateViewFork(STATE_VIEW).getSlot0(POOL_ID);
    }

    /// @dev Spot price in wei of ETH per 1e18 SPARE base units (the price unit of SparecycleJobPaymentsV2).
    function _spotPrice() internal view returns (uint256) {
        uint256 s = _sqrtP();
        return Math.mulDiv(Math.mulDiv(1e18, 1 << 96, s), 1 << 96, s);
    }

    /// @dev SPARE an amount of ETH is worth at the spot price, before fee and impact.
    function _spotSpareFor(uint256 ethIn) internal view returns (uint256) {
        uint256 s = _sqrtP();
        return Math.mulDiv(Math.mulDiv(ethIn, s, 1 << 96), s, 1 << 96);
    }

    /// @dev ETH an amount of SPARE is worth at the spot price, before fee and impact.
    function _spotEthFor(uint256 spareIn) internal view returns (uint256) {
        uint256 s = _sqrtP();
        return Math.mulDiv(Math.mulDiv(spareIn, 1 << 96, s), 1 << 96, s);
    }

    /// @dev The pool's in-range ETH-side (virtual) reserve L / sqrtP: the whole ETH side for this full-range pool.
    function _ethReserve() internal view returns (uint256) {
        return Math.mulDiv(IStateViewFork(STATE_VIEW).getLiquidity(POOL_ID), 1 << 96, _sqrtP());
    }

    function _assertAdapterEmpty() internal view {
        assertEq(address(adapter).balance, 0, "adapter keeps no ETH");
        assertEq(spare.balanceOf(address(adapter)), 0, "adapter keeps no SPARE");
        assertEq(spare.allowance(address(adapter), POOL_MANAGER), 0, "adapter gives no allowance");
    }

    /// @dev 1 - got / ref, in hundredths of a bp (so 290 bps prints as 29000).
    function _costCbps(uint256 got, uint256 ref) internal pure returns (uint256) {
        return got >= ref ? 0 : ((ref - got) * 1e6) / ref;
    }
}
