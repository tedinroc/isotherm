// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Isotherm OutcomeToken
/// @notice YES or NO leg of one "Tmax >= k degC" strike. 6 decimals, so 1 token pays exactly 1 AUSD (6 decimals)
///         when it wins. Supply only changes through the vault (complete-set mint/burn and redemption).
/// @dev Deployed once as an implementation by the CollateralVault, then instantiated per series as an EIP-1167
///      clone with immutable args `abi.encode(bytes32 seriesId, bytes4 station, uint32 date, int16 strikeC, bool isYes)`.
///      - `vault` is an immutable of the implementation, so every clone shares it through DELEGATECALL.
///      - EIP-2612: the EIP-712 domain is {name: "Isotherm Outcome", version: "1", chainId, verifyingContract: clone},
///        discoverable via ERC-5267 `eip712Domain()`. The domain name is shared, the verifyingContract is per clone,
///        so a permit for one strike can never be replayed on another.
contract OutcomeToken is ERC20Permit {
    using Strings for uint256;

    /// @notice The CollateralVault, sole minter/burner.
    address public immutable vault;
    address private immutable _self;

    error OnlyVault();

    constructor(address vault_) ERC20("Isotherm Outcome", "ISO") ERC20Permit("Isotherm Outcome") {
        vault = vault_;
        _self = address(this);
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    function mint(address to, uint256 amount) external onlyVault {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyVault {
        _burn(from, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Series this token belongs to.
    function seriesInfo()
        public
        view
        returns (bytes32 seriesId, bytes4 station, uint32 date, int16 strikeC, bool isYes)
    {
        if (address(this) == _self) {
            return (bytes32(0), bytes4(0), 0, 0, false); // bare implementation
        }
        return abi.decode(Clones.fetchCloneArgs(address(this)), (bytes32, bytes4, uint32, int16, bool));
    }

    /// @notice e.g. "Isotherm RCSS 20261007 Tmax>=30C YES"
    function name() public view override returns (string memory) {
        if (address(this) == _self) return "Isotherm Outcome (implementation)";
        (, bytes4 station, uint32 date, int16 strikeC, bool isYes) = seriesInfo();
        return string.concat(
            "Isotherm ",
            string(abi.encodePacked(station)),
            " ",
            uint256(date).toString(),
            " Tmax>=",
            Strings.toStringSigned(strikeC),
            "C ",
            isYes ? "YES" : "NO"
        );
    }

    /// @notice e.g. "RCSS-20261007-GE30-Y"
    function symbol() public view override returns (string memory) {
        if (address(this) == _self) return "ISO-IMPL";
        (, bytes4 station, uint32 date, int16 strikeC, bool isYes) = seriesInfo();
        return string.concat(
            string(abi.encodePacked(station)),
            "-",
            uint256(date).toString(),
            "-GE",
            Strings.toStringSigned(strikeC),
            isYes ? "-Y" : "-N"
        );
    }
}
