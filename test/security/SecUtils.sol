// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IReceiver} from "../../src/interfaces/IReceiver.sol";

/// @dev Same routing semantics as Chainlink's MockKeystoneForwarder (spikes/cre/ref/chainlink-evm/MockKeystoneForwarder.sol):
///      permissionless, no signature checks, metadata = rawReport[45:109] and report = rawReport[109:] are taken
///      verbatim from the CALLER, a reverting receiver is swallowed and only reported via ReportProcessed(result=false).
contract PermissionlessForwarder {
    event ReportProcessed(
        address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result
    );

    function report(address receiver, bytes calldata rawReport, bytes calldata, bytes[] calldata)
        external
        returns (bool ok)
    {
        bytes memory payload = abi.encodeCall(IReceiver.onReport, (rawReport[45:109], rawReport[109:]));
        (ok,) = receiver.call(payload);
        emit ReportProcessed(receiver, bytes32(rawReport[1:33]), bytes2(rawReport[107:109]), ok);
    }
}

library RawReport {
    /// @dev 109-byte CRE header: version | execId | ts | donId | cfgVer | workflowId | name | owner | reportId.
    function build(bytes32 execId, bytes32 workflowId, address workflowOwner, bytes memory payload)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            uint8(1),
            execId,
            uint32(100),
            uint32(1),
            uint32(1),
            workflowId,
            bytes10("7721568293"),
            workflowOwner,
            bytes2(0x0001),
            payload
        );
    }
}

interface ITokenHook {
    function onTokenReceived(address from, uint256 amount) external;
}

/// @dev 6-decimal collateral that calls back the recipient (ERC-777 style) when `hookTarget` receives tokens.
contract HookToken is ERC20 {
    address public hookTarget;

    constructor() ERC20("Hook USD", "HUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setHookTarget(address t) external {
        hookTarget = t;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to == hookTarget && from != address(0)) ITokenHook(to).onTokenReceived(from, value);
    }
}

/// @dev 6-decimal collateral that burns 1% of every transfer (what an AUSD upgrade to a fee model would look like).
contract FeeToken is ERC20 {
    constructor() ERC20("Fee USD", "FUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}
