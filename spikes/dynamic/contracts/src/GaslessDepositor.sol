// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal AUSD surface used here (Agora Dollar implements EIP-3009 + EIP-2612,
/// including the `bytes signature` overloads that also accept ERC-1271).
interface IAUSD {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @notice Spike for Isotherm's gasless deposit path. The real series contract
/// would mint a YES+NO complete set instead of crediting `deposits`.
/// `receiveWithAuthorization` requires msg.sender == to, so an authorization
/// signed for this contract cannot be front-run into a bare transfer.
contract GaslessDepositor {
    IAUSD public immutable ausd;
    mapping(address => uint256) public deposits;

    event Deposited(address indexed user, uint256 amount, address indexed relayer, bool viaPermit);

    constructor(IAUSD ausd_) {
        ausd = ausd_;
    }

    /// Relayer submits the user's EIP-3009 ReceiveWithAuthorization (to = this).
    function depositWithAuthorization(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        ausd.receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, signature);
        deposits[from] += value;
        emit Deposited(from, value, msg.sender, false);
    }

    /// Relayer submits the user's EIP-2612 permit, then pulls funds.
    /// The permit call is wrapped in try/catch so a front-run permit cannot grief the deposit.
    function depositWithPermit(address owner, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        try ausd.permit(owner, address(this), value, deadline, v, r, s) {} catch {}
        require(ausd.allowance(owner, address(this)) >= value, "permit/allowance");
        require(ausd.transferFrom(owner, address(this), value), "transferFrom");
        deposits[owner] += value;
        emit Deposited(owner, value, msg.sender, true);
    }
}
