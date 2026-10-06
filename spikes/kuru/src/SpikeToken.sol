// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal 6-decimal ERC-20 with a single minter. Spike-only stand-in for an Isotherm outcome
///         token ("YES ≥30°C RCSS 2026-10-08"). The production token comes from StrikeFactory.
contract SpikeToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    address public immutable minter;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, address _minter) {
        name = _name;
        symbol = _symbol;
        minter = _minter;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "not minter");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == minter, "not minter");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @notice Spike-only complete-set minter: 1 AUSD (6 dp) <-> 1 YES + 1 NO (both 6 dp). No settlement logic;
///         it exists only so the fork test can prove the "buy NO = mint set + market-sell YES" zap path.
contract SpikeCompleteSet {
    address public immutable collateral; // AUSD
    SpikeToken public immutable yes;
    SpikeToken public immutable no;

    constructor(address _collateral, string memory label) {
        collateral = _collateral;
        yes = new SpikeToken(string.concat("YES ", label), "YES", address(this));
        no = new SpikeToken(string.concat("NO ", label), "NO", address(this));
    }

    function mint(address to, uint256 amount) external {
        _pull(collateral, msg.sender, amount);
        yes.mint(to, amount);
        no.mint(to, amount);
    }

    function merge(address to, uint256 amount) external {
        yes.burn(msg.sender, amount);
        no.burn(msg.sender, amount);
        _push(collateral, to, amount);
    }

    function _pull(address t, address from, uint256 amt) internal {
        (bool ok, bytes memory r) = t.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amt));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "pull");
    }

    function _push(address t, address to, uint256 amt) internal {
        (bool ok, bytes memory r) = t.call(abi.encodeWithSelector(0xa9059cbb, to, amt));
        require(ok && (r.length == 0 || abi.decode(r, (bool))), "push");
    }
}
