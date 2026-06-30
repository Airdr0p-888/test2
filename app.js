import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.min.js";

const CONTRACT_SOURCE = String.raw`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPancakeRouterV2 {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);
    function addLiquidityETH(address token,uint amountTokenDesired,uint amountTokenMin,uint amountETHMin,address to,uint deadline) external payable returns (uint amountToken, uint amountETH, uint liquidity);
    function addLiquidity(address tokenA,address tokenB,uint amountADesired,uint amountBDesired,uint amountAMin,uint amountBMin,address to,uint deadline) external returns (uint amountA, uint amountB, uint liquidity);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin,address[] calldata path,address to,uint deadline) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline) external;
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline) external;
}

interface IPancakeFactoryV2 {
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IPancakePairV2 {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

contract FairMintTokenV1 is ERC20, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum MintMode { BNB, USDT }
    enum UserMintMode { PERCENT, FIXED }
    enum LaunchMode { MANUAL, TIME, AUTO }
    uint256 public constant DENOMINATOR = 10000;
    uint256 public constant MAX_TAX = 500;
    uint256 public constant MAX_SELL_TAX = 10000;
    MintMode public mintMode;
    LaunchMode public launchMode;
    address public usdtAddress;
    IPancakeRouterV2 public router;
    address public pair;
    uint256 public mintPrice;
    uint256 public tokenPerMint;
    uint256 public maxMintCount;
    uint256 public mintedCount;
    UserMintMode public userMintMode;
    uint256 public userMintShare;
    uint256 public userMintAmount;
    uint256 public lpFundShare;
    uint256 public launchTime;
    uint256 public startTime;
    uint256 public openTime;
    uint256 public tradingStartTime;
    bool public mintEnabled = true;
    bool public tradingOpen;
    mapping(address => bool) public hasMinted;
    bool public whitelistEnabled;
    mapping(address => bool) public whitelist;
    mapping(address => bool) public isExcludedFromLimits;
    mapping(address => bool) public isExcludedFromFee;
    mapping(address => uint256) public boughtAmount;
    bool public buyLimitEnabled;
    uint256 public maxBuyAmountPerWallet;
    mapping(address => uint256) public boughtBaseAmount;
    bool public buyAmountLimitEnabled;
    uint256 public maxBuyBaseAmountPerWallet;
    bool public buyWhitelistEnabled;
    mapping(address => bool) public buyWhitelist;
    bool public preLaunchBuyWhitelistEnabled;
    mapping(address => bool) public preLaunchBuyWhitelist;
    uint256 public buyTax;
    uint256 public sellTax;
    uint256 public transferTax;
    uint256 public marketingShare;
    uint256 public burnShare;
    uint256 public lpShare;
    uint256 public dividendShare;
    address public marketingWallet;
    address public rewardToken;
    address public deadWallet;
    bool public swapEnabled = true;
    bool private inSwap;
    bool public taxesLocked;
    bool public feeExemptionsLocked;
    bool public pauseDisabledForever;
    uint256 public swapThreshold;
    uint256 public pendingTaxTokens;
    uint256 public tokenDividendPerShare;
    uint256 public lpDividendPerShare;
    uint256 public dividendReserve;
    uint256 public minTokenDividendBalance;
    uint256 private constant ACC = 1e36;
    mapping(address => bool) public isExcludedFromDividends;
    mapping(address => bool) private dividendExclusionKnown;
    address[] public dividendExcludedAddresses;
    uint256 public excludedTokenBalance;
    mapping(address => uint256) public tokenDividendDebt;
    mapping(address => uint256) public tokenDividendCredit;
    mapping(address => uint256) public lpDividendDebt;
    mapping(address => uint256) public lpBalanceSnapshot;
    address[] public dividendHolders;
    mapping(address => bool) public isDividendHolder;
    uint256 public dividendProcessIndex;
    bool public autoDividendEnabled = true;
    uint256 public autoDividendBatchSize = 5;
    event Minted(address indexed user, uint256 paidAmount, uint256 userTokens, uint256 lpTokens, uint256 lpFund);
    event TradingOpened(uint256 timestamp);
    event SwapBack(uint256 tokenAmount, uint256 receivedAmount);
    event TokenDividendFunded(uint256 amount);
    event LPDividendFunded(uint256 amount);
    event DividendClaimed(address indexed user, uint256 tokenReward, uint256 lpReward);
    event AutoDividendProcessed(uint256 processed, uint256 paid);
    modifier lockSwap() { inSwap = true; _; inSwap = false; }
    constructor(string memory name_, string memory symbol_, uint256 totalSupply_, MintMode mintMode_, address usdtAddress_, address router_, uint256 mintPrice_, uint256 tokenPerMint_, uint256 maxMintCount_, UserMintMode userMintMode_, uint256 userMintShare_, uint256 userMintAmount_, uint256 lpFundShare_, LaunchMode launchMode_, uint256 launchTime_, address marketingWallet_, address owner_, address rewardToken_, uint256 buyTax_, uint256 sellTax_, uint256 transferTax_, uint256 marketingShare_, uint256 burnShare_, uint256 lpShare_, uint256 dividendShare_, bool buyLimitEnabled_, uint256 maxBuyAmountPerWallet_, uint256 minTokenDividendBalance_, bool buyAmountLimitEnabled_, uint256 maxBuyBaseAmountPerWallet_, bool buyWhitelistEnabled_, bool preLaunchBuyWhitelistEnabled_) ERC20(name_, symbol_) Ownable(owner_) {
        require(totalSupply_ > 0, "totalSupply zero");
        require(router_ != address(0), "router zero");
        require(marketingWallet_ != address(0), "marketing zero");
        require(owner_ != address(0), "owner zero");
        require(userMintShare_ <= DENOMINATOR, "bad user share");
        if (userMintMode_ == UserMintMode.FIXED) require(userMintAmount_ <= tokenPerMint_, "bad user amount");
        require(lpFundShare_ <= DENOMINATOR, "bad lp fund share");
        require(buyTax_ <= MAX_TAX && transferTax_ <= MAX_TAX, "buy/transfer tax > 5%");
        require(sellTax_ <= MAX_SELL_TAX, "sell tax > 100%");
        require(marketingShare_ + burnShare_ + lpShare_ + dividendShare_ == DENOMINATOR, "sum != 10000");
        if (buyLimitEnabled_) require(maxBuyAmountPerWallet_ > 0, "buy limit zero");
        if (buyAmountLimitEnabled_) require(maxBuyBaseAmountPerWallet_ > 0, "buy amount limit zero");
        if (mintMode_ == MintMode.USDT) require(usdtAddress_ != address(0), "usdt zero");
        require(rewardToken_ != address(this), "bad reward token");
        if (launchMode_ == LaunchMode.TIME) require(launchTime_ > block.timestamp, "bad launch time");
        mintMode = mintMode_;
        usdtAddress = usdtAddress_;
        router = IPancakeRouterV2(router_);
        mintPrice = mintPrice_;
        tokenPerMint = tokenPerMint_;
        maxMintCount = maxMintCount_;
        userMintMode = userMintMode_;
        userMintShare = userMintShare_;
        userMintAmount = userMintAmount_;
        lpFundShare = lpFundShare_;
        launchMode = launchMode_;
        _setLaunchTime(launchTime_);
        marketingWallet = marketingWallet_;
        rewardToken = rewardToken_;
        buyTax = buyTax_;
        sellTax = sellTax_;
        transferTax = transferTax_;
        marketingShare = marketingShare_;
        burnShare = burnShare_;
        lpShare = lpShare_;
        dividendShare = dividendShare_;
        buyLimitEnabled = buyLimitEnabled_;
        maxBuyAmountPerWallet = maxBuyAmountPerWallet_;
        buyAmountLimitEnabled = buyAmountLimitEnabled_;
        maxBuyBaseAmountPerWallet = maxBuyBaseAmountPerWallet_;
        buyWhitelistEnabled = buyWhitelistEnabled_;
        preLaunchBuyWhitelistEnabled = preLaunchBuyWhitelistEnabled_;
        minTokenDividendBalance = minTokenDividendBalance_;
        deadWallet = 0x000000000000000000000000000000000000dEaD;
        address base = mintMode_ == MintMode.BNB ? router.WETH() : usdtAddress_;
        pair = IPancakeFactoryV2(router.factory()).createPair(address(this), base);
        _mint(address(this), totalSupply_);
        swapThreshold = totalSupply_ / 1000;
        isExcludedFromLimits[owner_] = true;
        isExcludedFromLimits[address(this)] = true;
        isExcludedFromLimits[router_] = true;
        isExcludedFromFee[owner_] = true;
        isExcludedFromFee[address(this)] = true;
        isExcludedFromFee[router_] = true;
        buyWhitelist[owner_] = true;
        buyWhitelist[address(this)] = true;
        buyWhitelist[router_] = true;
        preLaunchBuyWhitelist[owner_] = true;
        _setExcludedFromDividends(address(0), true);
        _setExcludedFromDividends(deadWallet, true);
        _setExcludedFromDividends(address(this), true);
        _setExcludedFromDividends(pair, true);
        _setExcludedFromDividends(router_, true);
    }
    receive() external payable nonReentrant whenNotPaused { if (msg.sender == address(router)) return; _mintBNB(msg.sender, msg.value); }
    function decimals() public pure override returns (uint8) { return 18; }
    function mintBNB() external payable nonReentrant whenNotPaused { _mintBNB(msg.sender, msg.value); }
    function _mintBNB(address user, uint256 amount) internal { require(mintMode == MintMode.BNB, "not BNB mode"); require(amount == mintPrice, "bad BNB amount"); _mintFlow(user, amount); }
    function mintUSDT() external nonReentrant whenNotPaused { require(mintMode == MintMode.USDT, "not USDT mode"); IERC20(usdtAddress).safeTransferFrom(msg.sender, address(this), mintPrice); _mintFlow(msg.sender, mintPrice); }
    function _mintFlow(address user, uint256 paidAmount) internal {
        require(mintEnabled, "mint disabled"); require(!hasMinted[user], "already minted"); require(mintedCount < maxMintCount, "mint full"); if (whitelistEnabled) require(whitelist[user], "not whitelisted");
        hasMinted[user] = true; mintedCount += 1;
        uint256 userTokens = userMintMode == UserMintMode.FIXED ? userMintAmount : tokenPerMint * userMintShare / DENOMINATOR;
        uint256 lpTokens = tokenPerMint - userTokens;
        uint256 lpFund = paidAmount * lpFundShare / DENOMINATOR;
        require(balanceOf(address(this)) >= tokenPerMint, "insufficient token reserve");
        if (lpTokens > 0 && lpFund > 0) {
            _approve(address(this), address(router), lpTokens);
            if (mintMode == MintMode.BNB) router.addLiquidityETH{value: lpFund}(address(this), lpTokens, 0, 0, owner(), block.timestamp);
            else { IERC20(usdtAddress).forceApprove(address(router), lpFund); router.addLiquidity(address(this), usdtAddress, lpTokens, lpFund, 0, 0, owner(), block.timestamp); }
        }
        if (userTokens > 0) _transfer(address(this), user, userTokens);
        emit Minted(user, paidAmount, userTokens, lpTokens, lpFund);
        if (mintedCount >= maxMintCount) { mintEnabled = false; if (launchMode == LaunchMode.AUTO) _openTrading(); }
    }
    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0)) { _updateExcludedTokenBalance(from, to, amount); super._update(from, to, amount); return; }
        uint256 grossAmount = amount;
        if (!tradingOpen && launchMode == LaunchMode.TIME && launchTime > 0 && block.timestamp >= launchTime) { tradingOpen = true; emit TradingOpened(block.timestamp); }
        bool exemptLimit = isExcludedFromLimits[from] || isExcludedFromLimits[to];
        bool preLaunchBuy = !tradingOpen && from == pair && preLaunchBuyWhitelistEnabled && preLaunchBuyWhitelist[to];
        if (!tradingOpen && !exemptLimit && !preLaunchBuy) revert("trading not open");
        if (!inSwap && swapEnabled && from != pair && from != address(this)) { uint256 taxTokenBalance = pendingTaxTokens; if (taxTokenBalance >= swapThreshold && swapThreshold > 0) _swapBack(taxTokenBalance); }
        uint256 taxAmount = 0;
        if (!inSwap && !isExcludedFromFee[from] && !isExcludedFromFee[to]) {
            uint256 taxRate; if (from == pair) taxRate = buyTax; else if (to == pair) taxRate = sellTax; else taxRate = transferTax;
            if (taxRate > 0) taxAmount = amount * taxRate / DENOMINATOR;
        }
        if (taxAmount > 0) { _updateExcludedTokenBalance(from, address(this), taxAmount); super._update(from, address(this), taxAmount); pendingTaxTokens += taxAmount; amount -= taxAmount; }
        if (from == pair && buyWhitelistEnabled && !preLaunchBuy) require(buyWhitelist[to], "buy whitelist");
        if (buyLimitEnabled && from == pair && !isExcludedFromLimits[to]) { boughtAmount[to] += amount; require(boughtAmount[to] <= maxBuyAmountPerWallet, "buy limit"); }
        if (buyAmountLimitEnabled && from == pair && !isExcludedFromLimits[to]) { boughtBaseAmount[to] += _baseAmountForBuy(grossAmount); require(boughtBaseAmount[to] <= maxBuyBaseAmountPerWallet, "buy amount limit"); }
        _accrueTokenDividend(from); _accrueTokenDividend(to); _updateExcludedTokenBalance(from, to, amount); super._update(from, to, amount); _settleTokenDividend(from); _settleTokenDividend(to); _trackDividendHolder(from); _trackDividendHolder(to);
    }
    function _updateExcludedTokenBalance(address from, address to, uint256 amount) internal {
        if (amount == 0 || from == to) return;
        if (from != address(0) && isExcludedFromDividends[from]) excludedTokenBalance -= amount;
        if (to != address(0) && isExcludedFromDividends[to]) excludedTokenBalance += amount;
    }
    function _baseAmountForBuy(uint256 tokenAmountOut) internal view returns (uint256) {
        IPancakePairV2 mainPair = IPancakePairV2(pair);
        (uint112 reserve0, uint112 reserve1,) = mainPair.getReserves();
        bool tokenIs0 = mainPair.token0() == address(this);
        uint256 reserveOut = tokenIs0 ? uint256(reserve0) : uint256(reserve1);
        uint256 reserveIn = tokenIs0 ? uint256(reserve1) : uint256(reserve0);
        require(tokenAmountOut > 0 && tokenAmountOut < reserveOut, "bad buy amount");
        return reserveIn * tokenAmountOut * 10000 / ((reserveOut - tokenAmountOut) * 9975) + 1;
    }
    function _openTrading() internal { if (!tradingOpen) { tradingOpen = true; mintEnabled = false; emit TradingOpened(block.timestamp); } }
    function openTrading() external onlyOwner { _openTrading(); }
    function closeMint() external onlyOwner { mintEnabled = false; }
    function _swapBack(uint256 tokenAmount) internal lockSwap {
        uint256 totalShare = marketingShare + burnShare + lpShare + dividendShare; if (totalShare == 0 || tokenAmount == 0) return;
        if (tokenAmount > pendingTaxTokens) tokenAmount = pendingTaxTokens;
        if (tokenAmount == 0) return;
        if (tokenAmount > swapThreshold * 5) tokenAmount = swapThreshold * 5;
        pendingTaxTokens -= tokenAmount;
        uint256 burnTokens = tokenAmount * burnShare / totalShare;
        uint256 lpTokens = tokenAmount * lpShare / totalShare;
        uint256 dividendTokens = tokenAmount * dividendShare / totalShare;
        uint256 marketingTokens = tokenAmount - burnTokens - lpTokens - dividendTokens;
        if (burnTokens > 0) { _updateExcludedTokenBalance(address(this), deadWallet, burnTokens); super._update(address(this), deadWallet, burnTokens); }
        uint256 lpTokenHalf = lpTokens / 2;
        uint256 tokensToSwap = marketingTokens + dividendTokens + lpTokenHalf;
        uint256 received;
        if (tokensToSwap > 0) {
            uint256 beforeBal = _baseBalance(); _approve(address(this), address(router), tokensToSwap);
            if (mintMode == MintMode.BNB) { address[] memory path = new address[](2); path[0] = address(this); path[1] = router.WETH(); router.swapExactTokensForETHSupportingFeeOnTransferTokens(tokensToSwap, 0, path, address(this), block.timestamp); }
            else { address[] memory path = new address[](2); path[0] = address(this); path[1] = usdtAddress; router.swapExactTokensForTokensSupportingFeeOnTransferTokens(tokensToSwap, 0, path, address(this), block.timestamp); }
            received = _baseBalance() - beforeBal;
        }
        if (received > 0) {
            uint256 marketingAmt = received * marketingTokens / tokensToSwap;
            uint256 dividendAmt = received * dividendTokens / tokensToSwap;
            uint256 lpAmt = received - marketingAmt - dividendAmt;
            _sendBase(marketingWallet, marketingAmt);
            _fundTokenDividendFromSwap(dividendAmt);
            if (lpAmt > 0 && lpTokenHalf > 0) { _approve(address(this), address(router), lpTokenHalf); if (mintMode == MintMode.BNB) router.addLiquidityETH{value: lpAmt}(address(this), lpTokenHalf, 0, 0, owner(), block.timestamp); else { IERC20(usdtAddress).forceApprove(address(router), lpAmt); router.addLiquidity(address(this), usdtAddress, lpTokenHalf, lpAmt, 0, 0, owner(), block.timestamp); } }
            if (autoDividendEnabled) _processAutoDividends(autoDividendBatchSize);
        }
        emit SwapBack(tokenAmount, received);
    }
    function forceSwapBack() external onlyOwner { _swapBack(pendingTaxTokens); }
    function forceAddLiquidity(uint256 tokenAmount, uint256 fundAmount) external payable onlyOwner nonReentrant lockSwap { require(tokenAmount > 0 && fundAmount > 0, "zero amount"); _approve(address(this), address(router), tokenAmount); if (mintMode == MintMode.BNB) { require(msg.value == fundAmount, "bad BNB"); router.addLiquidityETH{value: fundAmount}(address(this), tokenAmount, 0, 0, owner(), block.timestamp); } else { IERC20(usdtAddress).safeTransferFrom(msg.sender, address(this), fundAmount); IERC20(usdtAddress).forceApprove(address(router), fundAmount); router.addLiquidity(address(this), usdtAddress, tokenAmount, fundAmount, 0, 0, owner(), block.timestamp); } }
    function rewardTokenAddress() public view returns (address) { return rewardToken == address(0) ? (mintMode == MintMode.BNB ? address(0) : usdtAddress) : rewardToken; }
    function _isNativeReward() internal view returns (bool) { return rewardTokenAddress() == address(0); }
    function _baseToken() internal view returns (address) { return mintMode == MintMode.BNB ? address(0) : usdtAddress; }
    function _baseBalance() internal view returns (uint256) { return mintMode == MintMode.BNB ? address(this).balance : IERC20(usdtAddress).balanceOf(address(this)); }
    function _rewardBalance() internal view returns (uint256) { return _isNativeReward() ? address(this).balance : IERC20(rewardTokenAddress()).balanceOf(address(this)); }
    function _sendBase(address to, uint256 amount) internal { if (amount == 0) return; if (mintMode == MintMode.BNB) payable(to).transfer(amount); else IERC20(usdtAddress).safeTransfer(to, amount); }
    function _sendReward(address to, uint256 amount) internal { if (amount == 0) return; if (_isNativeReward()) payable(to).transfer(amount); else IERC20(rewardTokenAddress()).safeTransfer(to, amount); }
    function _convertBaseToReward(uint256 amount) internal returns (uint256) {
        if (amount == 0) return 0;
        address target = rewardTokenAddress();
        address base = _baseToken();
        if (target == base) return amount;
        uint256 beforeBal = IERC20(target).balanceOf(address(this));
        if (mintMode == MintMode.BNB) { address[] memory path = new address[](2); path[0] = router.WETH(); path[1] = target; router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: amount}(0, path, address(this), block.timestamp); }
        else { IERC20(usdtAddress).forceApprove(address(router), amount); address[] memory path = new address[](3); path[0] = usdtAddress; path[1] = router.WETH(); path[2] = target; router.swapExactTokensForTokensSupportingFeeOnTransferTokens(amount, 0, path, address(this), block.timestamp); }
        return IERC20(target).balanceOf(address(this)) - beforeBal;
    }
    function eligibleTokenDividendSupply() public view returns (uint256) { return totalSupply() - excludedTokenBalance; }
    function eligibleLPDividendSupply() public view returns (uint256) {
        uint256 supply = IERC20(pair).totalSupply();
        for (uint256 i; i < dividendExcludedAddresses.length; i++) {
            address user = dividendExcludedAddresses[i];
            if (!isExcludedFromDividends[user]) continue;
            uint256 excludedLP = IERC20(pair).balanceOf(user);
            if (excludedLP >= supply) return 0;
            supply -= excludedLP;
        }
        return supply;
    }
    function dividendExcludedCount() external view returns (uint256) { return dividendExcludedAddresses.length; }
    function _fundTokenDividendFromSwap(uint256 baseAmount) internal { if (baseAmount == 0) return; uint256 rewardAmount = _isNativeReward() ? baseAmount : _convertBaseToReward(baseAmount); uint256 circulating = eligibleTokenDividendSupply(); if (circulating == 0) { _sendReward(marketingWallet, rewardAmount); return; } dividendReserve += rewardAmount; tokenDividendPerShare += rewardAmount * ACC / circulating; emit TokenDividendFunded(rewardAmount); }
    function fundTokenDividendBNB() external payable onlyOwner { require(_isNativeReward(), "not native reward"); _fundTokenDividendManual(msg.value); }
    function fundTokenDividendToken(uint256 amount) public onlyOwner { require(!_isNativeReward(), "native reward"); IERC20(rewardTokenAddress()).safeTransferFrom(msg.sender, address(this), amount); _fundTokenDividendManual(amount); }
    function fundTokenDividendUSDT(uint256 amount) external onlyOwner { require(rewardTokenAddress() == usdtAddress, "not USDT reward"); fundTokenDividendToken(amount); }
    function _fundTokenDividendManual(uint256 amount) internal { uint256 circulating = eligibleTokenDividendSupply(); require(circulating > 0, "no circulating supply"); dividendReserve += amount; tokenDividendPerShare += amount * ACC / circulating; emit TokenDividendFunded(amount); }
    function fundLPDividendBNB() external payable onlyOwner { require(_isNativeReward(), "not native reward"); _fundLPDividendManual(msg.value); }
    function fundLPDividendToken(uint256 amount) public onlyOwner { require(!_isNativeReward(), "native reward"); IERC20(rewardTokenAddress()).safeTransferFrom(msg.sender, address(this), amount); _fundLPDividendManual(amount); }
    function fundLPDividendUSDT(uint256 amount) external onlyOwner { require(rewardTokenAddress() == usdtAddress, "not USDT reward"); fundLPDividendToken(amount); }
    function _fundLPDividendManual(uint256 amount) internal { uint256 lpSupply = eligibleLPDividendSupply(); require(lpSupply > 0, "no lp supply"); dividendReserve += amount; lpDividendPerShare += amount * ACC / lpSupply; emit LPDividendFunded(amount); }
    function claimDividends() external nonReentrant { require(!isExcludedFromDividends[msg.sender], "dividend excluded"); uint256 tokenReward = pendingTokenDividend(msg.sender); uint256 lpReward = pendingLPDividend(msg.sender); uint256 reward = tokenReward + lpReward; tokenDividendCredit[msg.sender] = 0; tokenDividendDebt[msg.sender] = balanceOf(msg.sender) * tokenDividendPerShare / ACC; lpBalanceSnapshot[msg.sender] = IERC20(pair).balanceOf(msg.sender); lpDividendDebt[msg.sender] = lpBalanceSnapshot[msg.sender] * lpDividendPerShare / ACC; if (reward > 0) { require(dividendReserve >= reward, "dividend reserve"); dividendReserve -= reward; _sendReward(msg.sender, reward); } emit DividendClaimed(msg.sender, tokenReward, lpReward); }
    function dividendHolderCount() external view returns (uint256) { return dividendHolders.length; }
    function pendingTokenDividend(address user) public view returns (uint256) { if (isExcludedFromDividends[user]) return 0; uint256 pending = tokenDividendCredit[user]; if (balanceOf(user) < minTokenDividendBalance) return pending; uint256 accumulated = balanceOf(user) * tokenDividendPerShare / ACC; if (accumulated > tokenDividendDebt[user]) pending += accumulated - tokenDividendDebt[user]; return pending; }
    function pendingLPDividend(address user) public view returns (uint256) { if (isExcludedFromDividends[user]) return 0; uint256 lpBal = IERC20(pair).balanceOf(user); uint256 accumulated = lpBal * lpDividendPerShare / ACC; if (accumulated <= lpDividendDebt[user]) return 0; return accumulated - lpDividendDebt[user]; }
    function syncLPDividendDebt() external { if (isExcludedFromDividends[msg.sender]) { lpBalanceSnapshot[msg.sender] = 0; lpDividendDebt[msg.sender] = 0; return; } lpBalanceSnapshot[msg.sender] = IERC20(pair).balanceOf(msg.sender); lpDividendDebt[msg.sender] = lpBalanceSnapshot[msg.sender] * lpDividendPerShare / ACC; }
    function _accrueTokenDividend(address user) internal { if (isExcludedFromDividends[user]) { tokenDividendCredit[user] = 0; tokenDividendDebt[user] = 0; return; } uint256 pending = pendingTokenDividend(user); if (pending > tokenDividendCredit[user]) tokenDividendCredit[user] = pending; tokenDividendDebt[user] = balanceOf(user) * tokenDividendPerShare / ACC; }
    function _settleTokenDividend(address user) internal { tokenDividendDebt[user] = isExcludedFromDividends[user] ? 0 : balanceOf(user) * tokenDividendPerShare / ACC; }
    function _trackDividendHolder(address user) internal { if (isExcludedFromDividends[user] || isDividendHolder[user]) return; uint256 bal = balanceOf(user); if (bal > 0 && bal >= minTokenDividendBalance) { isDividendHolder[user] = true; dividendHolders.push(user); } }
    function _processAutoDividends(uint256 maxCount) internal {
        uint256 total = dividendHolders.length;
        if (total == 0 || maxCount == 0 || dividendReserve == 0) return;
        uint256 processed;
        uint256 paid;
        uint256 iterations;
        while (processed < maxCount && iterations < total && dividendReserve > 0) {
            if (dividendProcessIndex >= total) dividendProcessIndex = 0;
            address user = dividendHolders[dividendProcessIndex];
            dividendProcessIndex += 1;
            iterations += 1;
            if (isExcludedFromDividends[user] || balanceOf(user) < minTokenDividendBalance) continue;
            uint256 tokenReward = pendingTokenDividend(user);
            uint256 lpReward = pendingLPDividend(user);
            uint256 reward = tokenReward + lpReward;
            if (reward == 0 || reward > dividendReserve) continue;
            if (_trySendReward(user, reward)) {
                tokenDividendCredit[user] = 0;
                tokenDividendDebt[user] = balanceOf(user) * tokenDividendPerShare / ACC;
                lpBalanceSnapshot[user] = IERC20(pair).balanceOf(user);
                lpDividendDebt[user] = lpBalanceSnapshot[user] * lpDividendPerShare / ACC;
                dividendReserve -= reward;
                paid += reward;
                processed += 1;
                emit DividendClaimed(user, tokenReward, lpReward);
            }
        }
        if (processed > 0) emit AutoDividendProcessed(processed, paid);
    }
    function _trySendReward(address to, uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        if (_isNativeReward()) { (bool ok,) = payable(to).call{value: amount, gas: 30000}(""); return ok; }
        (bool success, bytes memory data) = rewardTokenAddress().call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        return success && (data.length == 0 || abi.decode(data, (bool)));
    }
    function setMintPrice(uint256 v) external onlyOwner { mintPrice = v; }
    function setTokenPerMint(uint256 v) external onlyOwner { if (userMintMode == UserMintMode.FIXED) require(userMintAmount <= v, "bad user amount"); tokenPerMint = v; }
    function setMaxMintCount(uint256 v) external onlyOwner { require(v >= mintedCount, "lt minted"); maxMintCount = v; }
    function setLaunchTime(uint256 v) external onlyOwner { _setLaunchTime(v); }
    function _setLaunchTime(uint256 v) internal { launchTime = v; startTime = v; openTime = v; tradingStartTime = v; }
    function setWhitelistEnabled(bool v) external onlyOwner { whitelistEnabled = v; }
    function setWhitelist(address user, bool v) external onlyOwner { whitelist[user] = v; }
    function batchSetWhitelist(address[] calldata users, bool v) external onlyOwner { for (uint i; i < users.length; i++) whitelist[users[i]] = v; }
    function setExcludedFromFee(address user, bool v) external onlyOwner { require(!feeExemptionsLocked, "fee exemptions locked"); isExcludedFromFee[user] = v; }
    function setBuyLimitEnabled(bool v) external onlyOwner { buyLimitEnabled = v; }
    function setMaxBuyAmountPerWallet(uint256 v) external onlyOwner { maxBuyAmountPerWallet = v; }
    function setBuyAmountLimitEnabled(bool v) external onlyOwner { if (v) require(maxBuyBaseAmountPerWallet > 0, "buy amount limit zero"); buyAmountLimitEnabled = v; }
    function setMaxBuyBaseAmountPerWallet(uint256 v) external onlyOwner { maxBuyBaseAmountPerWallet = v; }
    function setBuyWhitelistEnabled(bool v) external onlyOwner { buyWhitelistEnabled = v; }
    function setBuyWhitelist(address user, bool v) external onlyOwner { require(user != address(0), "zero address"); buyWhitelist[user] = v; }
    function batchSetBuyWhitelist(address[] calldata users, bool v) external onlyOwner { for (uint i; i < users.length; i++) { require(users[i] != address(0), "zero address"); buyWhitelist[users[i]] = v; } }
    function setPreLaunchBuyWhitelistEnabled(bool v) external onlyOwner { preLaunchBuyWhitelistEnabled = v; }
    function setPreLaunchBuyWhitelist(address user, bool v) external onlyOwner { require(user != address(0), "zero address"); preLaunchBuyWhitelist[user] = v; }
    function batchSetPreLaunchBuyWhitelist(address[] calldata users, bool v) external onlyOwner { for (uint i; i < users.length; i++) { require(users[i] != address(0), "zero address"); preLaunchBuyWhitelist[users[i]] = v; } }
    function _isCoreDividendExcluded(address user) internal view returns (bool) { return user == address(0) || user == deadWallet || user == address(this) || user == pair || user == address(router); }
    function _setExcludedFromDividends(address user, bool v) internal {
        if (isExcludedFromDividends[user] == v) return;
        if (v) {
            isExcludedFromDividends[user] = true;
            excludedTokenBalance += balanceOf(user);
            tokenDividendCredit[user] = 0;
            tokenDividendDebt[user] = 0;
            lpBalanceSnapshot[user] = 0;
            lpDividendDebt[user] = 0;
            if (!dividendExclusionKnown[user]) { dividendExclusionKnown[user] = true; dividendExcludedAddresses.push(user); }
        } else {
            isExcludedFromDividends[user] = false;
            excludedTokenBalance -= balanceOf(user);
            tokenDividendDebt[user] = balanceOf(user) * tokenDividendPerShare / ACC;
            lpBalanceSnapshot[user] = IERC20(pair).balanceOf(user);
            lpDividendDebt[user] = lpBalanceSnapshot[user] * lpDividendPerShare / ACC;
        }
    }
    function setExcludedFromDividends(address user, bool v) external onlyOwner { if (!v) require(!_isCoreDividendExcluded(user), "core dividend exclusion"); _setExcludedFromDividends(user, v); }
    function batchSetExcludedFromDividends(address[] calldata users, bool v) external onlyOwner { for (uint256 i; i < users.length; i++) { if (!v) require(!_isCoreDividendExcluded(users[i]), "core dividend exclusion"); _setExcludedFromDividends(users[i], v); } }
    function setMinTokenDividendBalance(uint256 v) external onlyOwner { minTokenDividendBalance = v; }
    function setAutoDividendEnabled(bool v) external onlyOwner { autoDividendEnabled = v; }
    function setAutoDividendBatchSize(uint256 v) external onlyOwner { require(v > 0 && v <= 20, "bad batch"); autoDividendBatchSize = v; }
    function lockTaxes() external onlyOwner { taxesLocked = true; }
    function lockFeeExemptions() external onlyOwner { feeExemptionsLocked = true; }
    function disablePauseForever() external onlyOwner { pauseDisabledForever = true; }
    function setBuyTax(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); require(v <= MAX_TAX, "tax > 5%"); buyTax = v; }
    function setSellTax(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); require(v <= MAX_SELL_TAX, "sell tax > 100%"); sellTax = v; }
    function setTransferTax(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); require(v <= MAX_TAX, "tax > 5%"); transferTax = v; }
    function setTaxShares(uint256 marketing, uint256 burn, uint256 lp, uint256 dividend) external onlyOwner { require(!taxesLocked, "taxes locked"); require(marketing + burn + lp + dividend == DENOMINATOR, "sum != 10000"); marketingShare = marketing; burnShare = burn; lpShare = lp; dividendShare = dividend; }
    function setMarketingShare(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); marketingShare = v; _checkShares(); }
    function setBurnShare(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); burnShare = v; _checkShares(); }
    function setLPShare(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); lpShare = v; _checkShares(); }
    function setDividendShare(uint256 v) external onlyOwner { require(!taxesLocked, "taxes locked"); dividendShare = v; _checkShares(); }
    function _checkShares() internal view { require(marketingShare + burnShare + lpShare + dividendShare == DENOMINATOR, "sum != 10000"); }
    function setMarketingWallet(address v) external onlyOwner { require(v != address(0), "zero"); marketingWallet = v; }
    function setRewardToken(address v) external onlyOwner { require(dividendReserve == 0, "reserve not empty"); require(v != address(this), "bad reward token"); rewardToken = v; }
    function setDeadWallet(address v) external onlyOwner { require(v != address(0), "zero"); deadWallet = v; }
    function setSwapEnabled(bool v) external onlyOwner { swapEnabled = v; }
    function setSwapThreshold(uint256 v) external onlyOwner { swapThreshold = v; }
    function pause() external onlyOwner { require(!pauseDisabledForever, "pause disabled"); require(!tradingOpen, "trading open"); _pause(); }
    function unpause() external onlyOwner { _unpause(); }
    function withdrawBNB(uint256 amount) external onlyOwner { uint256 bal = address(this).balance; uint256 locked = _isNativeReward() ? dividendReserve : 0; require(bal > locked, "no available BNB"); uint256 available = bal - locked; uint256 toSend = amount == 0 ? available : amount; require(toSend <= available, "exceeds available"); payable(owner()).transfer(toSend); }
    function withdrawToken(address token, uint256 amount) external onlyOwner { IERC20 erc = IERC20(token); uint256 bal = erc.balanceOf(address(this)); uint256 locked = (!_isNativeReward() && token == rewardTokenAddress()) ? dividendReserve : 0; require(bal > locked, "no available token"); uint256 available = bal - locked; uint256 toSend = amount == 0 ? available : amount; require(toSend <= available, "exceeds available"); erc.safeTransfer(owner(), toSend); }
    function withdrawDividendReserve(uint256 amount) external onlyOwner { uint256 toSend = amount == 0 ? dividendReserve : amount; require(toSend <= dividendReserve, "exceeds reserve"); dividendReserve -= toSend; _sendReward(owner(), toSend); }
    function withdrawLP(uint256 amount) external onlyOwner { IERC20 lpToken = IERC20(pair); uint256 bal = lpToken.balanceOf(address(this)); lpToken.safeTransfer(owner(), amount == 0 ? bal : amount); }
}`;

const FACTORY_SOURCE = String.raw`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Create2Factory {
    event Deployed(address indexed deployed, bytes32 indexed salt);

    function deploy(bytes32 salt, bytes memory bytecode) external payable returns (address deployed) {
        require(bytecode.length != 0, "bytecode empty");
        assembly {
            deployed := create2(callvalue(), add(bytecode, 0x20), mload(bytecode), salt)
        }
        require(deployed != address(0), "create2 failed");
        emit Deployed(deployed, salt);
    }

    function computeAddress(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }
}`;

const ZERO = "0x0000000000000000000000000000000000000000";
const OPENZEPPELIN_BASE = "https://unpkg.com/@openzeppelin/contracts@5.0.2/";
const ERC20_ABI = [
  "function approve(address spender,uint256 amount) external returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];
function compiledConstructorTypes() {
  const constructor = state.compiled?.abi?.find((item) => item.type === "constructor");
  if (!constructor) throw new Error("编译结果中没有找到构造函数。");
  return constructor.inputs.map((input) => input.type);
}
const NETWORK_DEFAULTS = {
  56: {
    name: "BSC 主网",
    native: "BNB",
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    usdt: "0x55d398326f99059fF775485246999027B3197955"
  },
  97: {
    name: "BSC 测试网",
    native: "tBNB",
    router: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    usdt: ""
  }
};
const state = { provider: null, signer: null, account: null, compiled: null, admin: null, mint: null };

const $ = (id) => document.getElementById(id);
const log = (msg) => { $("log").textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + $("log").textContent; };
const parseToken = (v) => ethers.parseUnits(String(v || "0"), 18);
const parseBool = (v) => v === true || v === "true";
const txDone = async (tx, label) => { log(`${label} 已提交：${tx.hash}`); await tx.wait(); log(`${label} 已确认`); };

async function approveIfNeeded(tokenAddress, spender, amount, label) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, state.signer);
  const allowance = await token.allowance(state.account, spender);
  if (allowance >= amount) return;
  await txDone(await token.approve(spender, amount), `${label} 授权`);
}

async function assertTokenBalance(tokenAddress, owner, amount, label) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, state.signer);
  const balance = await token.balanceOf(owner);
  if (balance < amount) throw new Error(`${label} 余额不足。需要 ${ethers.formatUnits(amount, 18)}，当前 ${ethers.formatUnits(balance, 18)}。`);
}

async function rewardInfo(contract) {
  const rewardAddress = await contract.rewardTokenAddress().catch(async () => {
    const mode = Number(await contract.mintMode());
    return mode === 0 ? ZERO : await contract.usdtAddress();
  });
  if (rewardAddress === ZERO) {
    const mode = Number(await contract.mintMode());
    const defaults = activeNetworkDefaults();
    return { address: ZERO, symbol: mode === 0 ? (defaults?.native || "BNB") : "USDT", decimals: 18, native: true };
  }
  const token = new ethers.Contract(rewardAddress, ERC20_ABI, state.signer || state.provider);
  const [symbol, decimals] = await Promise.all([
    token.symbol().catch(() => "TOKEN"),
    token.decimals().catch(() => 18)
  ]);
  return { address: rewardAddress, symbol, decimals: Number(decimals), native: false };
}

function makeDownload(id, filename, content, type = "application/json") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = $(id);
  if (link.dataset.url) URL.revokeObjectURL(link.dataset.url);
  link.href = url;
  link.dataset.url = url;
  link.download = filename;
}

function jsonSafe(value) {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

const deployFormEl = () => $("deployForm");

function formField(name) {
  return deployFormEl()?.elements?.[name];
}

function percentToBp(value) {
  return BigInt(Math.round(Number(value || 0) * 100));
}

function activeNetworkDefaults() {
  return state.network ? NETWORK_DEFAULTS[Number(state.network.chainId)] : null;
}

function shouldReplaceAddress(input, knownValues) {
  const value = (input.value || "").trim().toLowerCase();
  if (!value) return true;
  return knownValues.filter(Boolean).map((v) => v.toLowerCase()).includes(value);
}

function applyNetworkDefaults(force = false) {
  const defaults = activeNetworkDefaults();
  if (!defaults) {
    updateDeployHints();
    return;
  }
  const router = formField("router");
  const usdt = formField("usdtAddress");
  const knownRouters = Object.values(NETWORK_DEFAULTS).map((n) => n.router);
  const knownUsdt = Object.values(NETWORK_DEFAULTS).map((n) => n.usdt);
  if (router && defaults.router && (force || shouldReplaceAddress(router, knownRouters))) router.value = defaults.router;
  if (usdt && defaults.usdt && (force || shouldReplaceAddress(usdt, knownUsdt))) usdt.value = defaults.usdt;
  updateDeployHints();
}

function setDefaultMarketingWallet(force = false) {
  const marketing = formField("marketingWallet");
  if (marketing && state.account && (force || !marketing.value.trim())) marketing.value = state.account;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return "0";
  // Show up to 10 fractional digits, strip trailing zeros
  if (Math.abs(value) < 1 && value !== 0) {
    return value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatBigIntRatio(numerator, denominator, precision = 30) {
  if (denominator <= 0n || numerator < 0n) return "-";
  const integer = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return integer.toString();
  const scale = 10n ** BigInt(precision);
  const fraction = (remainder * scale / denominator).toString().padStart(precision, "0").replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer.toString();
}

function launchPriceDetails(form) {
  const mintPriceRaw = parseToken(form.elements.mintPrice.value);
  const tokenPerMintRaw = parseToken(form.elements.tokenPerMint.value);
  const userMintMode = Number(form.elements.userMintMode.value);
  const userShareBp = percentToBp(form.elements.userMintShare.value);
  const userMintAmountRaw = parseToken(form.elements.userMintAmount.value);
  const lpFundShareBp = percentToBp(form.elements.lpFundShare.value);
  const lpFundRaw = mintPriceRaw * lpFundShareBp / 10000n;
  const userTokenRaw = userMintMode === 1 ? userMintAmountRaw : tokenPerMintRaw * userShareBp / 10000n;
  if (userTokenRaw > tokenPerMintRaw) throw new Error("用户到账数量不能大于单次 Mint 代币数");
  const lpTokenRaw = tokenPerMintRaw - userTokenRaw;
  const defaults = activeNetworkDefaults();
  const currency = Number(form.elements.mintMode.value) === 0 ? (defaults?.native || "BNB") : "USDT";
  return { mintPriceRaw, tokenPerMintRaw, userMintMode, userShareBp, userMintAmountRaw, userTokenRaw, lpFundShareBp, lpFundRaw, lpTokenRaw, currency };
}

function applyTargetLaunchPrice() {
  const form = deployFormEl();
  if (!form) return;
  const targetInput = form.elements.targetLaunchPrice;
  const hint = $("targetLaunchPriceHint");
  const rawValue = String(targetInput.value || "").trim();
  if (!rawValue) { if (hint) hint.textContent = ""; return; }
  try {
    const targetPriceRaw = parseToken(rawValue);
    const mintPriceRaw = parseToken(form.elements.mintPrice.value);
    const userMintMode = Number(form.elements.userMintMode.value);
    const userShareBp = percentToBp(form.elements.userMintShare.value);
    const userMintAmountRaw = parseToken(form.elements.userMintAmount.value);
    const lpFundShareBp = percentToBp(form.elements.lpFundShare.value);
    const lpTokenShareBp = 10000n - userShareBp;
    if (targetPriceRaw <= 0n) throw new Error("目标开盘单价必须大于0");
    if (mintPriceRaw <= 0n || lpFundShareBp <= 0n) throw new Error("进入流动性的资金必须大于0");
    if (userMintMode === 0 && lpTokenShareBp <= 0n) throw new Error("用户拿币比例不能是100%");
    const lpTokenRaw = mintPriceRaw * lpFundShareBp * 10n ** 18n / (targetPriceRaw * 10000n);
    const tokenPerMintRaw = userMintMode === 1
      ? lpTokenRaw + userMintAmountRaw
      : mintPriceRaw * lpFundShareBp * 10n ** 18n / (targetPriceRaw * lpTokenShareBp);
    if (tokenPerMintRaw <= 0n) throw new Error("目标单价过高，无法计算代币数量");
    form.elements.tokenPerMint.value = ethers.formatUnits(tokenPerMintRaw, 18);
    const totalRaw = parseToken(form.elements.totalSupply.value);
    const maxMint = totalRaw / tokenPerMintRaw;
    if (maxMint > 0n) {
      form.elements.maxMintCount.value = maxMint.toString();
      if (hint) { hint.textContent = "已按目标开盘单价计算Mint配置"; hint.classList.remove("error"); hint.classList.add("ok"); }
    } else if (hint) {
      hint.textContent = "总供应量不足以覆盖一份Mint，请先提高总供应量";
      hint.classList.remove("ok");
      hint.classList.add("error");
    }
    updateDeployHints();
  } catch (error) {
    if (hint) { hint.textContent = error.message || String(error); hint.classList.remove("ok"); hint.classList.add("error"); }
  }
}

function updateDeployHints() {
  const form = deployFormEl();
  if (!form) return;
  const total = Number(form.elements.totalSupply.value || 0);
  const perMint = Number(form.elements.tokenPerMint.value || 0);
  const maxMint = Number(form.elements.maxMintCount.value || 0);
  const price = Number(form.elements.mintPrice.value || 0);
  const userMintMode = Number(form.elements.userMintMode.value || 0);
  const userShare = Number(form.elements.userMintShare.value || 0);
  const userMintAmount = Number(form.elements.userMintAmount.value || 0);
  const lpFundShare = Number(form.elements.lpFundShare.value || 0);
  const mintedTokenPlan = perMint * maxMint;
  const remaining = total - mintedTokenPlan;
  const userTokensPerMint = userMintMode === 1 ? userMintAmount : perMint * userShare / 100;
  const lpTokensPerMint = perMint - userTokensPerMint;
  const lpFundPerMint = price * lpFundShare / 100;
  const retainedFundPerMint = price - lpFundPerMint;
  const defaults = activeNetworkDefaults();
  const currency = Number(form.elements.mintMode.value) === 0 ? (defaults?.native || "BNB") : "USDT";
  let launchPrice = "-";
  try {
    const details = launchPriceDetails(form);
    if (details.lpFundRaw > 0n && details.lpTokenRaw > 0n) launchPrice = `${formatBigIntRatio(details.lpFundRaw, details.lpTokenRaw)} ${details.currency}/枚`;
  } catch { /* incomplete form input */ }
  const targetCurrency = $("targetLaunchPriceCurrency");
  if (targetCurrency) targetCurrency.textContent = `${currency}/枚`;
  renderStats("deployHints", [
    ["单次 Mint 代币数", formatNumber(perMint)],
    ["Mint 覆盖代币", formatNumber(mintedTokenPlan)],
    ["合约剩余预留", formatNumber(remaining)],
    ["预计总募集", `${formatNumber(price * maxMint)} ${currency}`],
    ["每次用户获得", formatNumber(userTokensPerMint)],
    ["每次进池代币", formatNumber(lpTokensPerMint)],
    ["每次进池资金", `${formatNumber(lpFundPerMint)} ${currency}`],
    ["每次合约留存资金", `${formatNumber(retainedFundPerMint)} ${currency}`],
    ["预计开盘单价", launchPrice]
  ]);
}

function formatDecimalForInput(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1) return String(Math.floor(value));
  // For sub-1 values: use enough precision, strip trailing zeros, avoid becoming "0"
  let s = value.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
  // Safety: if all decimal digits are 0 (value < 1e-18), show scientific-like format
  if (s === "0" || s === "") {
    s = value.toExponential(8).replace(/0+$/, "").replace(/\.$/, "");
  }
  return s;
}

function syncMintPlan(changedName) {
  const form = deployFormEl();
  if (!form) return;
  const total = Number(form.elements.totalSupply.value || 0);
  const perMintInput = form.elements.tokenPerMint;
  const maxMintInput = form.elements.maxMintCount;
  const perMint = Number(perMintInput.value || 0);
  const maxMint = Number(maxMintInput.value || 0);

  const safePlanMath = Number.isSafeInteger(total) && Number.isSafeInteger(maxMint);
  if ((changedName === "totalSupply" || changedName === "maxMintCount") && total > 0 && maxMint > 0 && safePlanMath) {
    const exact = total / maxMint;
    perMintInput.value = formatDecimalForInput(exact);
  }
  if (changedName === "tokenPerMint" && total > 0 && perMint > 0 && Number.isSafeInteger(total / perMint)) {
    maxMintInput.value = String(Math.floor(total / perMint));
  }
  updateDeployHints();
}

function updateUserMintModeUI() {
  const form = deployFormEl();
  if (!form) return;
  const fixedMode = Number(form.elements.userMintMode.value) === 1;
  const shareInput = form.elements.userMintShare;
  const amountInput = form.elements.userMintAmount;
  shareInput.disabled = fixedMode;
  shareInput.required = !fixedMode;
  amountInput.disabled = !fixedMode;
  amountInput.required = fixedMode;
  amountInput.setCustomValidity("");
  if (fixedMode) {
    try {
      if (parseToken(amountInput.value) > parseToken(form.elements.tokenPerMint.value)) {
        amountInput.setCustomValidity("用户到账数量不能大于单次 Mint 代币数");
      }
    } catch { /* native form validation handles incomplete values */ }
  }
  const target = form.elements.targetLaunchPrice.value.trim();
  if (target) applyTargetLaunchPrice();
  else updateDeployHints();
}

function parseAddressList(value) {
  const addresses = String(value || "")
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (!addresses.length) throw new Error("请先填写批量地址。");
  return addresses.map((address) => {
    if (!ethers.isAddress(address)) throw new Error(`地址格式不正确：${address}`);
    return ethers.getAddress(address);
  });
}

function readDeployTaxConfig(form) {
  syncTaxShareControls();
  const config = {
    buyTax: percentToBp(form.elements.buyTax.value),
    sellTax: percentToBp(form.elements.sellTax.value),
    transferTax: percentToBp(form.elements.transferTax.value),
    marketingShare: percentToBp(form.elements.marketingShare.value),
    burnShare: percentToBp(form.elements.burnShare.value),
    lpShare: percentToBp(form.elements.lpShare.value),
    dividendShare: percentToBp(form.elements.dividendShare.value)
  };
  if (config.marketingShare + config.burnShare + config.lpShare + config.dividendShare !== 10000n) {
    throw new Error("税收分配四项必须合计 100%。");
  }
  return config;
}

const TAX_SHARE_NAMES = ["marketingShare", "burnShare", "lpShare", "dividendShare"];
const TAX_SHARE_LABELS = {
  marketingShare: "营销钱包",
  burnShare: "代币销毁",
  lpShare: "回流 LP",
  dividendShare: "持币分红"
};

function taxShareValue(name) {
  return Number(formField(name)?.value || 0);
}

function taxShareNumberField(name) {
  return formField(`${name}Number`);
}

function setTaxShareValue(name, value) {
  const range = formField(name);
  const number = taxShareNumberField(name);
  const normalized = Math.max(0, Math.min(100, Math.round(Number(value || 0) * 100) / 100));
  if (range) range.value = String(normalized);
  if (number) number.value = String(normalized);
}

function syncTaxShareControls(changedName = null, rawValue = null) {
  if (changedName) {
    const othersTotal = TAX_SHARE_NAMES
      .filter((name) => name !== changedName)
      .reduce((sum, name) => sum + taxShareValue(name), 0);
    const maxAllowed = Math.max(0, 100 - othersTotal);
    setTaxShareValue(changedName, Math.min(Number(rawValue || 0), maxAllowed));
  }

  const values = Object.fromEntries(TAX_SHARE_NAMES.map((name) => [name, taxShareValue(name)]));
  const total = TAX_SHARE_NAMES.reduce((sum, name) => sum + values[name], 0);
  const remaining = Math.round((100 - total) * 100) / 100;

  for (const name of TAX_SHARE_NAMES) {
    const otherTotal = total - values[name];
    const maxAllowed = Math.max(0, Math.round((100 - otherTotal) * 100) / 100);
    const range = formField(name);
    const number = taxShareNumberField(name);
    if (range) range.max = String(maxAllowed);
    if (number) number.max = String(maxAllowed);
    if (range) range.disabled = maxAllowed === 0 && values[name] === 0;
    if (number) number.disabled = maxAllowed === 0 && values[name] === 0;
  }

  const hint = $("taxShareHint");
  if (hint) {
    const parts = TAX_SHARE_NAMES.map((name) => `${TAX_SHARE_LABELS[name]} ${values[name]}%`);
    hint.textContent = remaining === 0
      ? `税收分配合计 100%：${parts.join(" / ")}`
      : `还剩 ${remaining}% 未分配，四项必须合计 100%。`;
    hint.classList.toggle("ok", remaining === 0);
    hint.classList.toggle("error", remaining !== 0);
  }
}

function readDeployLimitConfig(form) {
  const config = {
    enabled: parseBool(form.elements.buyLimitEnabled.value),
    maxAmount: parseToken(form.elements.maxBuyAmountPerWallet.value),
    amountEnabled: parseBool(form.elements.buyAmountLimitEnabled.value),
    maxBaseAmount: parseToken(form.elements.maxBuyBaseAmountPerWallet.value),
    whitelistEnabled: parseBool(form.elements.buyWhitelistEnabled.value),
    preLaunchWhitelistEnabled: parseBool(form.elements.preLaunchBuyWhitelistEnabled.value)
  };
  if (config.enabled && config.maxAmount == 0n) throw new Error("开启限购时，单钱包累计限购代币数必须大于 0。");
  if (config.amountEnabled && config.maxBaseAmount == 0n) throw new Error("开启金额限购时，单钱包累计限购金额必须大于 0。");
  return config;
}

function readVanityConfig(form) {
  const enabled = parseBool(form.elements.vanityEnabled.value);
  const suffix = String(form.elements.vanitySuffix.value || "").trim().toLowerCase().replace(/^0x/, "");
  if (!enabled) return { enabled, suffix: "" };
  if (!suffix) throw new Error("开启尾号定制时，请填写目标尾号。");
  if (!/^[0-9a-f]+$/.test(suffix)) throw new Error("目标尾号只能填写 0-9 或 a-f。");
  if (suffix.length > 5) throw new Error("目标尾号最多建议 5 位，避免浏览器计算过慢。");
  return { enabled, suffix };
}

async function findCreate2Salt(factoryAddress, initCode, suffix) {
  const initCodeHash = ethers.keccak256(initCode);
  const normalizedSuffix = suffix.toLowerCase();
  const max = 10_000_000;
  for (let i = 0; i < max; i++) {
    const salt = ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [state.account, BigInt(i)]));
    const address = ethers.getCreate2Address(factoryAddress, salt, initCodeHash);
    if (address.toLowerCase().endsWith(normalizedSuffix)) return { salt, address, attempts: i + 1 };
    if (i > 0 && i % 50000 === 0) {
      log(`尾号计算中：已尝试 ${i.toLocaleString()} 次...`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw new Error("没有在当前搜索范围内找到目标尾号，请缩短尾号或换一个尾号。");
}

async function applyPostDeploySettings(contract, form) {
  const tax = readDeployTaxConfig(form);
  const limit = readDeployLimitConfig(form);
  const jobs = [
    ["设置买入税", tax.buyTax, () => contract.setBuyTax(tax.buyTax)],
    ["设置卖出税", tax.sellTax, () => contract.setSellTax(tax.sellTax)],
    ["设置转账税", tax.transferTax, () => contract.setTransferTax(tax.transferTax)],
    ["设置税收分配", 1n, () => contract.setTaxShares(tax.marketingShare, tax.burnShare, tax.lpShare, tax.dividendShare)],
    ["设置限购数量", limit.maxAmount, () => contract.setMaxBuyAmountPerWallet(limit.maxAmount)],
    ["设置限购开关", limit.enabled ? 1n : 0n, () => contract.setBuyLimitEnabled(limit.enabled)],
    ["设置金额限购", limit.maxBaseAmount, () => contract.setMaxBuyBaseAmountPerWallet(limit.maxBaseAmount)],
    ["设置金额限购开关", limit.amountEnabled ? 1n : 0n, () => contract.setBuyAmountLimitEnabled(limit.amountEnabled)],
    ["设置买入白名单开关", limit.whitelistEnabled ? 1n : 0n, () => contract.setBuyWhitelistEnabled(limit.whitelistEnabled)],
    ["设置开盘前买入白名单开关", limit.preLaunchWhitelistEnabled ? 1n : 0n, () => contract.setPreLaunchBuyWhitelistEnabled(limit.preLaunchWhitelistEnabled)]
  ];
  for (const [label, value, call] of jobs) {
    if (value > 0n) await txDone(await call(), label);
  }
}

function getInjectedWallet() {
  const eth = window.ethereum;
  const candidates = [
    ...(eth?.providers || []),
    window.tokenpocket?.ethereum,
    window.tp?.ethereum,
    eth
  ].filter(Boolean);
  const metamask = candidates.find((p) => p.isMetaMask);
  const tokenPocket = candidates.find((p) => p.isTokenPocket || p.isTpWallet || p.isTokenPocketWallet);
  return metamask || tokenPocket || candidates[0] || null;
}

function walletHelpText() {
  const url = location.href;
  return [
    "没有检测到钱包插件。",
    "电脑端请用安装了 MetaMask 的 Chrome/Edge 打开本页面。",
    "手机端请在 TokenPocket 或 MetaMask App 内置浏览器打开：",
    url
  ].join("\n");
}

function compileWithWorker(input) {
  const workerCode = `
    import solc from "https://esm.sh/solc@0.8.24";
    self.onmessage = (event) => {
      try {
        const output = solc.compile(JSON.stringify(event.data), {
          import: (path) => ({ error: "Missing import " + path })
        });
        self.postMessage({ ok: true, output });
      } catch (error) {
        self.postMessage({ ok: false, error: error && error.message ? error.message : String(error) });
      }
    };
  `;
  const blob = new Blob([workerCode], { type: "text/javascript" });
  const workerUrl = URL.createObjectURL(blob);
  const worker = new Worker(workerUrl, { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = (event) => {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      if (event.data.ok) resolve(JSON.parse(event.data.output));
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      reject(new Error(event.message || "Solidity compiler worker failed"));
    };
    worker.postMessage(input);
  });
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
}

async function connectWallet() {
  const injected = getInjectedWallet();
  if (!injected) throw new Error(walletHelpText());
  state.provider = new ethers.BrowserProvider(injected);
  await state.provider.send("eth_requestAccounts", []);
  state.signer = await state.provider.getSigner();
  state.account = await state.signer.getAddress();
  const network = await state.provider.getNetwork();
  state.network = network;
  $("walletAddress").textContent = state.account;
  $("networkName").textContent = `${network.name} / chainId ${network.chainId}`;
  setDefaultMarketingWallet();
  applyNetworkDefaults();
}

function normalizeImport(path) {
  if (path === "@openzeppelin/contracts/security/Pausable.sol") return "@openzeppelin/contracts/utils/Pausable.sol";
  if (path === "@openzeppelin/contracts/security/ReentrancyGuard.sol") return "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
  return path;
}

function resolveImport(importPath, fromPath) {
  const fixed = normalizeImport(importPath);
  if (fixed.startsWith("@openzeppelin/contracts/")) return fixed;
  if (fixed.startsWith("./") || fixed.startsWith("../")) {
    const base = fromPath.split("/").slice(0, -1);
    for (const part of fixed.split("/")) {
      if (part === "." || !part) continue;
      if (part === "..") base.pop();
      else base.push(part);
    }
    return normalizeImport(base.join("/"));
  }
  return fixed;
}

async function fetchSource(path, sources, seen) {
  if (seen.has(path)) return;
  seen.add(path);
  let content;
  if (path === "FairMintTokenV1.sol") content = CONTRACT_SOURCE;
  else if (path === "Create2Factory.sol") content = FACTORY_SOURCE;
  else {
    const url = OPENZEPPELIN_BASE + path.replace("@openzeppelin/contracts/", "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`无法读取依赖：${path}`);
    content = await res.text();
  }
  sources[path] = { content };
  const imports = [...content.matchAll(/import\s+(?:[^"']+from\s+)?["']([^"']+)["'];/g)].map((m) => m[1]);
  for (const item of imports) await fetchSource(resolveImport(item, path), sources, seen);
}

async function compileContract() {
  log("开始准备编译依赖...");
  const sources = {};
  await fetchSource("FairMintTokenV1.sol", sources, new Set());
  await fetchSource("Create2Factory.sol", sources, new Set());
  const input = {
    language: "Solidity",
    sources,
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  };
  const output = await compileWithWorker(input);
  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const contract = output.contracts["FairMintTokenV1.sol"].FairMintTokenV1;
  const factory = output.contracts["Create2Factory.sol"].Create2Factory;
  state.compiled = {
    abi: contract.abi,
    bytecode: "0x" + contract.evm.bytecode.object,
    factoryAbi: factory.abi,
    factoryBytecode: "0x" + factory.evm.bytecode.object,
    standardJsonInput: input
  };
  log(`编译完成，ABI ${contract.abi.length} 项，构造参数 ${compiledConstructorTypes().length} 项。`);
  return state.compiled;
}

function deployArgs(form) {
  if (!(form instanceof HTMLFormElement)) throw new Error("没有读取到部署表单，请刷新页面后重试。");
  const fd = new FormData(form);
  const tax = readDeployTaxConfig(form);
  const limit = readDeployLimitConfig(form);
  const launchRaw = fd.get("launchTime");
  const launchTime = launchRaw ? Math.floor(new Date(launchRaw).getTime() / 1000) : 0;
  return [
    fd.get("name"),
    fd.get("symbol"),
    parseToken(fd.get("totalSupply")),
    Number(fd.get("mintMode")),
    fd.get("usdtAddress") || ZERO,
    fd.get("router"),
    parseToken(fd.get("mintPrice")),
    parseToken(fd.get("tokenPerMint")),
    BigInt(fd.get("maxMintCount")),
    Number(fd.get("userMintMode")),
    percentToBp(fd.get("userMintShare")),
    parseToken(fd.get("userMintAmount")),
    percentToBp(fd.get("lpFundShare")),
    Number(fd.get("launchMode")),
    BigInt(launchTime),
    fd.get("marketingWallet") || state.account,
    state.account,
    fd.get("rewardToken") || ZERO,
    tax.buyTax,
    tax.sellTax,
    tax.transferTax,
    tax.marketingShare,
    tax.burnShare,
    tax.lpShare,
    tax.dividendShare,
    limit.enabled,
    limit.maxAmount,
    parseToken(fd.get("minTokenDividendBalance")),
    limit.amountEnabled,
    limit.maxBaseAmount,
    limit.whitelistEnabled,
    limit.preLaunchWhitelistEnabled
  ];
}

async function deployContract(form) {
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  await ensureWallet();
  if (!state.compiled) await compileContract();
  setDefaultMarketingWallet();
  applyNetworkDefaults();
  const args = deployArgs(form);
  const constructorTypes = compiledConstructorTypes();
  if (constructorTypes.length !== args.length) {
    throw new Error(`构造参数数量不匹配：合约需要 ${constructorTypes.length} 项，网页生成 ${args.length} 项，请刷新后重新编译。`);
  }
  const vanity = readVanityConfig(form);
  let contract;
  let address;
  let deploymentHash;
  let factoryAddress = null;
  let vanitySalt = null;
  if (vanity.enabled) {
    log("请在钱包中确认 CREATE2 工厂部署交易...");
    const create2Factory = new ethers.ContractFactory(state.compiled.factoryAbi, state.compiled.factoryBytecode, state.signer);
    const deployedFactory = await create2Factory.deploy();
    deploymentHash = deployedFactory.deploymentTransaction().hash;
    log(`工厂部署交易已提交：${deploymentHash}`);
    await deployedFactory.waitForDeployment();
    factoryAddress = await deployedFactory.getAddress();
    log(`工厂部署完成：${factoryAddress}`);
    const encodedArgs = ethers.AbiCoder.defaultAbiCoder().encode(constructorTypes, args).slice(2);
    const initCode = state.compiled.bytecode + encodedArgs;
    log(`开始计算合约尾号：${vanity.suffix}`);
    const found = await findCreate2Salt(factoryAddress, initCode, vanity.suffix);
    vanitySalt = found.salt;
    address = found.address;
    log(`找到目标地址：${address}，尝试 ${found.attempts.toLocaleString()} 次`);
    const tx = await deployedFactory.deploy(vanitySalt, initCode);
    deploymentHash = tx.hash;
    log(`Token 部署交易已提交：${deploymentHash}`);
    await tx.wait();
    contract = new ethers.Contract(address, state.compiled.abi, state.signer);
  } else {
    log("请在钱包中确认部署交易...");
    const tokenFactory = new ethers.ContractFactory(state.compiled.abi, state.compiled.bytecode, state.signer);
    contract = await tokenFactory.deploy(...args);
    deploymentHash = contract.deploymentTransaction().hash;
    log(`部署交易已提交：${deploymentHash}`);
    await contract.waitForDeployment();
    address = await contract.getAddress();
  }
  const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(constructorTypes, args).slice(2);
  const deploymentInfo = {
    contractAddress: address,
    contractName: "FairMintTokenV1.sol:FairMintTokenV1",
    compilerVersion: "v0.8.24+commit.e11b9ed9",
    openZeppelinVersion: "5.0.2",
    optimizer: { enabled: true, runs: 200, viaIR: true },
    constructorArguments: constructorArgs,
    constructorValues: args,
    vanity: vanity.enabled ? { factoryAddress, salt: vanitySalt, suffix: vanity.suffix } : null,
    deployer: state.account,
    chainId: (await state.provider.getNetwork()).chainId.toString(),
    transactionHash: deploymentHash,
    deployedAt: new Date().toISOString()
  };
  makeDownload("downloadStandardJson", "verify-standard-json-input.json", jsonSafe(state.compiled.standardJsonInput));
  makeDownload("downloadConstructorArgs", "constructor-args.txt", constructorArgs, "text/plain");
  makeDownload("downloadDeploymentInfo", "deployment-info.json", jsonSafe(deploymentInfo));
  $("verificationBox").hidden = false;
  $("adminContractAddress").value = address;
  $("mintContractAddress").value = address;
  state.admin = contract;
  state.mint = contract;
  log(`部署完成：${address}`);
  await refreshAdmin();
  await refreshMint();
  saveDeployedToken(address, args);
}

// ── Ave.ai 市场数据抓取（CORS 代理 + API Key 作为 URL 参数）──
const AVE_API_KEY = 'UgbYEGOBtEx8r3uLTxCJPx7sEaYYMvZ6219iLSdYBUIFwbzu3HZ9qMeMprSdkHp9';
async function fetchAndCacheAveData(address) {
  // 尝试多种方式获取 Ave.ai 数据
  const attempts = [
    // 方式1: CORS 代理 + API Key 作为 URL 查询参数
    {
      label: 'corsproxy+key',
      fn: async () => {
        const url = `https://prod.ave-api.com/v2/tokens?keyword=${encodeURIComponent(address)}&chain=bsc&api_key=${AVE_API_KEY}`;
        const proxy = 'https://corsproxy.io/?' + encodeURIComponent(url);
        const res = await fetch(proxy);
        return res.ok ? res.json() : null;
      }
    },
    // 方式2: 另一个 CORS 代理
    {
      label: 'allorigins',
      fn: async () => {
        const url = `https://prod.ave-api.com/v2/tokens?keyword=${encodeURIComponent(address)}&chain=bsc&api_key=${AVE_API_KEY}`;
        const proxy = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        const res = await fetch(proxy);
        return res.ok ? res.json() : null;
      }
    },
    // 方式3: 直接请求（部分浏览器/环境可能放行）
    {
      label: 'direct',
      fn: async () => {
        const url = `https://prod.ave-api.com/v2/tokens?keyword=${encodeURIComponent(address)}&chain=bsc`;
        const res = await fetch(url, { headers: { 'X-API-KEY': AVE_API_KEY } });
        return res.ok ? res.json() : null;
      }
    }
  ];

  for (const attempt of attempts) {
    try {
      const data = await attempt.fn();
      if (!data) continue;
      const tokens = data?.data || [];
      const match = Array.isArray(tokens)
        ? tokens.find(t => (t.token || '').toLowerCase() === address.toLowerCase())
        : null;
      if (match) {
        return {
          symbol: match.symbol || '',
          name: match.name || '',
          price_usd: String(match.current_price_usd ?? ''),
          change_24h: String(match.price_change_24h ?? ''),
          volume_24h: String(match.tx_volume_u_24h ?? ''),
          market_cap: String(match.market_cap ?? ''),
          holders: match.holders ?? 0,
          updated_at: Math.floor(Date.now() / 1000)
        };
      }
    } catch (e) { /* try next */ }
  }
  return null;
}

// ── 提示用户一键提交到公开广场 ──
function showAddToPublicLink(address) {
  const link = `https://github.com/Airdr0p-888/gold-launchpad/actions/workflows/add-token.yml`;
  log(`<a href="${link}" target="_blank" style="color:#D4A017;text-decoration:underline;">👉 点此加入公开广场白名单</a>（粘贴合约地址 <b>${address}</b>，点「Run workflow」，约1分钟后代币广场刷新即可看到行情数据）`);
}

// ── 本地存储 ──
function saveDeployedToken(address, args) {
  try {
    const storageKey = 'goldlaunch_local_tokens';
    const existing = JSON.parse(localStorage.getItem(storageKey) || '[]');

    // Avoid duplicates
    if (existing.some(t => t.address && t.address.toLowerCase() === address.toLowerCase())) return;

    const [name, symbol, totalSupply, , , , mintPrice, tokenPerMint, maxMintCount] = args;
    const dec = 18;
    const progress = 0; // Just deployed
    const colors = ['#D4A017','#F5C842','#38BDF8','#34D399','#FB923C','#F472B6','#A78BFA','#22D3EE'];
    const color = colors[Math.floor(Math.random() * colors.length)];

    existing.push({
      rank: 0,
      name: name,
      sym: symbol,
      color: color,
      price: Number(String(mintPrice === 0n ? '0' : ethers.formatUnits(mintPrice, 18))),
      change: 0,
      cap: '--',
      vol: '--',
      progress: 0,
      status: 'live',
      address: address,
      imported: true,
      totalSupply: String(totalSupply === 0n ? '0' : ethers.formatUnits(totalSupply, dec)),
      decimals: dec,
      mintedCount: 0,
      maxMintCount: Number(maxMintCount),
      mintEnabled: true,
      tradingOpen: false
    });

    localStorage.setItem(storageKey, JSON.stringify(existing));
    log(`合约信息已保存到本地存储，可在 GOLDLAUNCH 代币广场查看。`);
    // 提示一键提交到公开广场
    showAddToPublicLink(address);
    // 背景抓取 Ave.ai 市场数据（非关键，不影响主流程）
    fetchAndCacheAveData(address).then(cached => {
      if (cached) {
        try {
          const list = JSON.parse(localStorage.getItem(storageKey) || '[]');
          const idx = list.findIndex(t => t.address && t.address.toLowerCase() === address.toLowerCase());
          if (idx >= 0) {
            list[idx].price = Number(cached.price_usd) || list[idx].price;
            list[idx].priceUsd = Number(cached.price_usd) || null;
            list[idx].change = cached.change_24h != null ? Number(cached.change_24h) : 0;
            list[idx].cap = cached.market_cap ? '$' + (Number(cached.market_cap) < 1000 ? Number(cached.market_cap).toFixed(2) : (Number(cached.market_cap)/1000).toFixed(1)+'K') : '--';
            list[idx].vol = cached.volume_24h ? '$' + (Number(cached.volume_24h) < 1000 ? Number(cached.volume_24h).toFixed(2) : (Number(cached.volume_24h)/1000).toFixed(1)+'K') : '--';
            list[idx].hasMarket = true;
            list[idx]._cached = cached;
            localStorage.setItem(storageKey, JSON.stringify(list));
          }
        } catch {}
      }
    });
  } catch (err) {
    // Non-critical, don't block the user
    console.warn('保存合约到本地存储失败:', err);
  }
}

async function ensureWallet() {
  if (!state.signer) await connectWallet();
}

async function contractAt(address) {
  await ensureWallet();
  if (!state.compiled) await compileContract();
  return new ethers.Contract(address, state.compiled.abi, state.signer);
}

async function refreshMint() {
  if (!state.mint) return;
  const reward = await rewardInfo(state.mint);
  const [mintPrice, tokenPerMint, mintedCount, maxMintCount, mintEnabled, mode, pendingToken, pendingLP, reserve] = await Promise.all([
    state.mint.mintPrice(), state.mint.tokenPerMint(), state.mint.mintedCount(), state.mint.maxMintCount(),
    state.mint.mintEnabled(), state.mint.mintMode(), state.mint.pendingTokenDividend(state.account), state.mint.pendingLPDividend(state.account),
    state.mint.dividendReserve()
  ]);
  renderStats("mintStats", [
    ["Mint 价格", ethers.formatUnits(mintPrice, 18)],
    ["单次代币", ethers.formatUnits(tokenPerMint, 18)],
    ["进度", `${mintedCount} / ${maxMintCount}`],
    ["Mint 状态", mintEnabled ? "开启" : "关闭"],
    ["模式", Number(mode) === 0 ? "BNB" : "USDT"],
    ["分红代币", reward.native ? reward.symbol : `${reward.symbol} ${reward.address}`],
    ["持币可领", `${ethers.formatUnits(pendingToken, reward.decimals)} ${reward.symbol}`],
    ["LP 可领", `${ethers.formatUnits(pendingLP, reward.decimals)} ${reward.symbol}`],
    ["分红储备", `${ethers.formatUnits(reserve, reward.decimals)} ${reward.symbol}`]
  ]);
}

async function refreshAdmin() {
  if (!state.admin) return;
  const reward = await rewardInfo(state.admin);
  const [
    owner, pair, mintMode, mintPrice, tokenPerMint, mintedCount, maxMintCount, mintEnabled, tradingOpen,
    buyTax, sellTax, transferTax, marketingShare, burnShare, lpShare, dividendShare, marketingWallet, swapThreshold, dividendReserve,
    buyLimitEnabled, maxBuyAmountPerWallet, minTokenDividendBalance, autoDividendEnabled, autoDividendBatchSize, dividendHolderCount,
    buyAmountLimitEnabled, maxBuyBaseAmountPerWallet,
    buyWhitelistEnabled,
    preLaunchBuyWhitelistEnabled,
    dividendExcludedCount, eligibleTokenDividendSupply, eligibleLPDividendSupply,
    taxesLocked, feeExemptionsLocked, pauseDisabledForever
  ] = await Promise.all([
    state.admin.owner(), state.admin.pair(), state.admin.mintMode(), state.admin.mintPrice(), state.admin.tokenPerMint(),
    state.admin.mintedCount(), state.admin.maxMintCount(), state.admin.mintEnabled(), state.admin.tradingOpen(),
    state.admin.buyTax(), state.admin.sellTax(), state.admin.transferTax(), state.admin.marketingShare(),
    state.admin.burnShare(), state.admin.lpShare(), state.admin.dividendShare(), state.admin.marketingWallet(), state.admin.swapThreshold(),
    state.admin.dividendReserve(), state.admin.buyLimitEnabled(), state.admin.maxBuyAmountPerWallet(), state.admin.minTokenDividendBalance(),
    state.admin.autoDividendEnabled(), state.admin.autoDividendBatchSize(), state.admin.dividendHolderCount(),
    state.admin.buyAmountLimitEnabled(), state.admin.maxBuyBaseAmountPerWallet(),
    state.admin.buyWhitelistEnabled(),
    state.admin.preLaunchBuyWhitelistEnabled(),
    state.admin.dividendExcludedCount(), state.admin.eligibleTokenDividendSupply(), state.admin.eligibleLPDividendSupply(),
    state.admin.taxesLocked(), state.admin.feeExemptionsLocked(), state.admin.pauseDisabledForever()
  ]);
  renderStats("adminStats", [
    ["Owner", owner], ["Pair", pair], ["Mint 模式", Number(mintMode) === 0 ? "BNB" : "USDT"],
    ["Mint 价格", ethers.formatUnits(mintPrice, 18)], ["单次代币", ethers.formatUnits(tokenPerMint, 18)],
    ["Mint 进度", `${mintedCount} / ${maxMintCount}`], ["Mint", mintEnabled ? "开启" : "关闭"],
    ["交易", tradingOpen ? "已开启" : "未开启"], ["买/卖/转税", `${buyTax}/${sellTax}/${transferTax} BP`],
    ["分配", `${marketingShare}/${burnShare}/${lpShare}/${dividendShare} BP`], ["营销钱包", marketingWallet],
    ["分红代币", reward.native ? reward.symbol : `${reward.symbol} ${reward.address}`],
    ["Swap 阈值", ethers.formatUnits(swapThreshold, 18)], ["分红储备", `${ethers.formatUnits(dividendReserve, reward.decimals)} ${reward.symbol}`],
    ["买入限购", buyLimitEnabled ? "开启" : "关闭"], ["单钱包限购", ethers.formatUnits(maxBuyAmountPerWallet, 18)],
    ["金额限购", buyAmountLimitEnabled ? "开启" : "关闭"], ["单钱包金额上限", `${ethers.formatUnits(maxBuyBaseAmountPerWallet, 18)} ${Number(mintMode) === 0 ? "BNB" : "USDT"}`],
    ["买入白名单", buyWhitelistEnabled ? "开启" : "关闭"],
    ["开盘前买入白名单", preLaunchBuyWhitelistEnabled ? "开启" : "关闭"],
    ["分红排除地址记录", dividendExcludedCount], ["持币分红有效供应", ethers.formatUnits(eligibleTokenDividendSupply, 18)],
    ["LP分红有效供应", ethers.formatUnits(eligibleLPDividendSupply, 18)],
    ["分红最低持仓", ethers.formatUnits(minTokenDividendBalance, 18)],
    ["自动分红", autoDividendEnabled ? `开启 / 每次 ${autoDividendBatchSize}` : "关闭"], ["分红地址数", dividendHolderCount],
    ["税锁定", taxesLocked ? "已锁定" : "未锁定"], ["免税锁定", feeExemptionsLocked ? "已锁定" : "未锁定"],
    ["暂停权限", pauseDisabledForever ? "永久禁用" : (tradingOpen ? "交易已开，不能暂停" : "可暂停")]
  ]);
}

function renderStats(id, items) {
  $(id).innerHTML = items.map(([k, v]) => `<div class="stat"><span>${k}</span><strong>${v}</strong></div>`).join("");
}

async function mintNow() {
  await ensureWallet();
  if (!state.mint) state.mint = await contractAt($("mintContractAddress").value.trim());
  const contractAddress = await state.mint.getAddress();
  const mode = Number(await state.mint.mintMode());
  const price = await state.mint.mintPrice();
  if (mode === 0) await txDone(await state.mint.mintBNB({ value: price }), "Mint");
  else {
    const usdt = await state.mint.usdtAddress();
    await assertTokenBalance(usdt, state.account, price, "USDT Mint");
    await approveIfNeeded(usdt, contractAddress, price, "USDT Mint");
    await txDone(await state.mint.mintUSDT(), "Mint");
  }
  await refreshMint();
}

async function adminAction(action) {
  await ensureWallet();
  if (!state.admin) state.admin = await contractAt($("adminContractAddress").value.trim());
  const c = state.admin;
  const contractAddress = await c.getAddress();
  const listAddress = $("listAddress").value.trim();
  const listValue = parseBool($("listValue").value);
  const mode = Number(await c.mintMode());
  const usdt = mode === 1 ? await c.usdtAddress() : ZERO;
  const reward = await rewardInfo(c);
  const renounceOwnership = async () => {
    if ($("renounceConfirmation").value.trim() !== "RENOUNCE") {
      throw new Error("请输入 RENOUNCE 确认永久丢弃管理员权限");
    }
    const [owner, tradingOpen] = await Promise.all([c.owner(), c.tradingOpen()]);
    if (owner.toLowerCase() !== state.account.toLowerCase()) throw new Error("当前钱包不是合约 Owner");
    if (!tradingOpen) throw new Error("必须先开启交易，才能丢弃管理员权限");
    return c.renounceOwnership();
  };
  const calls = {
    setMintPrice: () => c.setMintPrice(parseToken($("newMintPrice").value)),
    setTokenPerMint: () => c.setTokenPerMint(parseToken($("newTokenPerMint").value)),
    setMaxMintCount: () => c.setMaxMintCount(BigInt($("newMaxMintCount").value)),
    setLaunchTime: () => c.setLaunchTime(BigInt(Math.floor(new Date($("newLaunchTime").value).getTime() / 1000))),
    openTrading: () => c.openTrading(),
    closeMint: () => c.closeMint(),
    pause: () => c.pause(),
    unpause: () => c.unpause(),
    disablePauseForever: () => c.disablePauseForever(),
    setWhitelistEnabled: () => c.setWhitelistEnabled(parseBool($("whitelistEnabled").value)),
    setWhitelist: () => c.setWhitelist(listAddress, listValue),
    batchSetWhitelist: () => c.batchSetWhitelist(parseAddressList($("batchListAddresses").value), listValue),
    setBuyWhitelistEnabled: () => c.setBuyWhitelistEnabled(parseBool($("buyWhitelistEnabled").value)),
    setBuyWhitelist: () => c.setBuyWhitelist(listAddress, listValue),
    batchSetBuyWhitelist: () => c.batchSetBuyWhitelist(parseAddressList($("batchListAddresses").value), listValue),
    setPreLaunchBuyWhitelistEnabled: () => c.setPreLaunchBuyWhitelistEnabled(parseBool($("preLaunchBuyWhitelistEnabled").value)),
    setPreLaunchBuyWhitelist: () => c.setPreLaunchBuyWhitelist(listAddress, listValue),
    batchSetPreLaunchBuyWhitelist: () => c.batchSetPreLaunchBuyWhitelist(parseAddressList($("batchListAddresses").value), listValue),
    setExcludedFromDividends: () => c.setExcludedFromDividends(listAddress, listValue),
    batchSetExcludedFromDividends: () => c.batchSetExcludedFromDividends(parseAddressList($("batchListAddresses").value), listValue),
    setExcludedFromFee: () => c.setExcludedFromFee(listAddress, listValue),
    lockFeeExemptions: () => c.lockFeeExemptions(),
    setBuyTax: () => c.setBuyTax(BigInt($("buyTax").value)),
    setSellTax: () => c.setSellTax(BigInt($("sellTax").value)),
    setTransferTax: () => c.setTransferTax(BigInt($("transferTax").value)),
    setTaxShares: () => c.setTaxShares(BigInt($("marketingShare").value), BigInt($("burnShare").value), BigInt($("lpShare").value), BigInt($("dividendShare").value)),
    lockTaxes: () => c.lockTaxes(),
    setMarketingWallet: () => c.setMarketingWallet($("marketingWallet").value.trim()),
    setRewardToken: () => c.setRewardToken($("rewardTokenAdmin").value.trim() || ZERO),
    setSwapThreshold: () => c.setSwapThreshold(parseToken($("swapThreshold").value)),
    setBuyLimitEnabled: () => c.setBuyLimitEnabled(parseBool($("buyLimitEnabled").value)),
    setMaxBuyAmountPerWallet: () => c.setMaxBuyAmountPerWallet(parseToken($("maxBuyAmountPerWallet").value)),
    setBuyAmountLimitEnabled: () => c.setBuyAmountLimitEnabled(parseBool($("buyAmountLimitEnabled").value)),
    setMaxBuyBaseAmountPerWallet: () => c.setMaxBuyBaseAmountPerWallet(parseToken($("maxBuyBaseAmountPerWallet").value)),
    setMinTokenDividendBalance: () => c.setMinTokenDividendBalance(parseToken($("minTokenDividendBalance").value)),
    setAutoDividendEnabled: () => c.setAutoDividendEnabled(parseBool($("autoDividendEnabled").value)),
    setAutoDividendBatchSize: () => c.setAutoDividendBatchSize(BigInt($("autoDividendBatchSize").value)),
    forceSwapBack: () => c.forceSwapBack(),
    fundTokenDividend: async () => {
      const amount = parseToken($("dividendAmount").value);
      if (reward.native) return c.fundTokenDividendBNB({ value: amount });
      await approveIfNeeded(reward.address, contractAddress, amount, `${reward.symbol} 分红`);
      return c.fundTokenDividendToken(amount);
    },
    fundLPDividend: async () => {
      const amount = parseToken($("lpDividendAmount").value);
      if (reward.native) return c.fundLPDividendBNB({ value: amount });
      await approveIfNeeded(reward.address, contractAddress, amount, `${reward.symbol} LP 分红`);
      return c.fundLPDividendToken(amount);
    },
    forceAddLiquidity: async () => {
      const tokenAmount = parseToken($("liqTokenAmount").value);
      const fundAmount = parseToken($("liqFundAmount").value);
      if (mode === 0) return c.forceAddLiquidity(tokenAmount, fundAmount, { value: fundAmount });
      await approveIfNeeded(usdt, contractAddress, fundAmount, "USDT 加池");
      return c.forceAddLiquidity(tokenAmount, fundAmount);
    },
    withdrawBNB: () => c.withdrawBNB($("withdrawBNBAmount").value ? parseToken($("withdrawBNBAmount").value) : 0n),
    withdrawToken: () => c.withdrawToken($("withdrawTokenAddress").value.trim(), $("withdrawTokenAmount").value ? parseToken($("withdrawTokenAmount").value) : 0n),
    withdrawDividendReserve: () => c.withdrawDividendReserve($("withdrawDividendReserveAmount").value ? parseToken($("withdrawDividendReserveAmount").value) : 0n),
    withdrawLP: () => c.withdrawLP($("withdrawLPAmount").value ? parseToken($("withdrawLPAmount").value) : 0n),
    renounceOwnership
  };
  if (!calls[action]) throw new Error(`未知操作：${action}`);
  await txDone(await calls[action](), action);
  if (action === "renounceOwnership") $("renounceConfirmation").value = "";
  await refreshAdmin();
}

document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll(".tab,.panel").forEach((el) => el.classList.remove("active"));
  btn.classList.add("active");
  $(btn.dataset.tab).classList.add("active");
}));

$("connectWallet").addEventListener("click", async (e) => run(e.currentTarget, connectWallet));
$("compileContract").addEventListener("click", async (e) => run(e.currentTarget, compileContract));
$("deployForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  run(e.submitter, () => deployContract(form));
});
$("loadMintInfo").addEventListener("click", async (e) => run(e.currentTarget, async () => { state.mint = await contractAt($("mintContractAddress").value.trim()); await refreshMint(); }));
$("mintNow").addEventListener("click", async (e) => run(e.currentTarget, mintNow));
$("claimDividends").addEventListener("click", async (e) => run(e.currentTarget, async () => { if (!state.mint) state.mint = await contractAt($("mintContractAddress").value.trim()); await txDone(await state.mint.claimDividends(), "领取分红"); await refreshMint(); }));
$("loadAdmin").addEventListener("click", async (e) => run(e.currentTarget, async () => { state.admin = await contractAt($("adminContractAddress").value.trim()); await refreshAdmin(); }));
$("refreshAdmin").addEventListener("click", async (e) => run(e.currentTarget, refreshAdmin));
document.querySelectorAll("[data-action]").forEach((btn) => btn.addEventListener("click", async () => run(btn, () => adminAction(btn.dataset.action))));

["totalSupply", "tokenPerMint", "maxMintCount", "mintPrice", "userMintShare", "userMintAmount", "lpFundShare"].forEach((name) => {
  const field = formField(name);
  if (!field) return;
  const sync = () => {
    if (["totalSupply", "tokenPerMint", "maxMintCount"].includes(name)) {
      const target = formField("targetLaunchPrice");
      if (target) target.value = "";
      const hint = $("targetLaunchPriceHint");
      if (hint) hint.textContent = "";
    }
    syncMintPlan(name);
    if (["tokenPerMint", "userMintAmount"].includes(name)) updateUserMintModeUI();
    if (["mintPrice", "userMintShare", "lpFundShare"].includes(name) && formField("targetLaunchPrice")?.value.trim()) applyTargetLaunchPrice();
  };
  field.addEventListener("input", sync);
  field.addEventListener("change", sync);
});
formField("targetLaunchPrice")?.addEventListener("input", applyTargetLaunchPrice);
formField("targetLaunchPrice")?.addEventListener("change", applyTargetLaunchPrice);
formField("userMintMode")?.addEventListener("change", updateUserMintModeUI);
TAX_SHARE_NAMES.forEach((name) => {
  formField(name)?.addEventListener("input", (event) => syncTaxShareControls(name, event.target.value));
  taxShareNumberField(name)?.addEventListener("input", (event) => syncTaxShareControls(name, event.target.value));
});
formField("mintMode")?.addEventListener("change", () => {
  applyNetworkDefaults();
  updateDeployHints();
});
window.ethereum?.on?.("chainChanged", () => {
  state.network = null;
  connectWallet().catch((err) => log(err.shortMessage || err.message || String(err)));
});
updateUserMintModeUI();
syncTaxShareControls();

const ERROR_TRANSLATIONS = [
  [/not\s*bnb\s*mode/i, "当前合约是 USDT 模式，不支持 BNB Mint"],
  [/not\s*usdt\s*mode/i, "当前合约是 BNB 模式，不支持 USDT Mint"],
  [/bad\s*bnb\s*amount/i, "发送的 BNB 金额不正确，请检查 Mint 价格"],
  [/mint\s*disabled/i, "Mint 已关闭"],
  [/already\s*minted/i, "该钱包已经 Mint 过了，每个地址限 Mint 一次"],
  [/mint\s*full/i, "Mint 已满/售罄"],
  [/not\s*whitelisted/i, "当前钱包不在白名单中，请联系管理员添加"],
  [/insufficient\s*token\s*reserve/i, "合约内代币储备不足以发放"],
  [/trading\s*not\s*open/i, "交易尚未开启"],
  [/buy\s*whitelist/i, "当前钱包不在买入白名单中"],
  [/dividend\s*excluded/i, "当前地址已被排除分红"],
  [/core\s*dividend\s*exclusion/i, "核心系统地址的分红排除不能取消"],
  [/buy\s*amount\s*limit/i, "超过单钱包累计买入金额限额"],
  [/buy\s*limit/i, "超过单钱包累计买入代币限额"],
  [/Pausable:\s*paused/i, "合约已暂停"],
  [/Ownable:\s*caller\s*is\s*not\s*the\s*owner/i, "当前钱包不是合约 Owner，无权操作"],
  [/ReentrancyGuard:\s*reentrant\s*call/i, "操作太频繁，请稍后再试"],
  [/ERC20:\s*transfer\s*amount\s*exceeds\s*balance/i, "代币余额不足"],
  [/ERC20:\s*insufficient\s*allowance/i, "代币授权不足，请先授权"],
  [/buy\/transfer\s*tax\s*>\s*5%/i, "买入税或转账税超过 5% 上限"],
  [/sell\s*tax\s*>\s*100%/i, "卖出税超过 100% 上限"],
  [/tax\s*>\s*5%/i, "税率超过 5% 上限"],
  [/sum\s*!=\s*10000/, "税收分配合计不等于 100%"],
  [/lt\s*minted/i, "新最大值不能小于已 Mint 数"],
  [/no\s*available\s*BNB/i, "无可提取的 BNB"],
  [/no\s*available\s*token/i, "无可提取的代币"],
  [/exceeds\s*available/i, "提取数量超过可用余额"],
  [/exceeds\s*reserve/i, "提取数量超过储备"],
  [/no\s*circulating\s*supply/i, "代币无流通供应（全在合约内）"],
  [/no\s*lp\s*supply/i, "无 LP 流动性供应"],
  [/bad\s*BNB/i, "发送的 BNB 金额不正确"],
  [/zero\s*amount/i, "数量不能为 0"],
  // Generic / undecoded
  [/unknown\s*custom\s*error/i, "合约执行失败，请确认操作条件是否满足（如 Mint 是否已关闭/已满，白名单，余额等）"],
];

function translateError(message) {
  for (const [pattern, translation] of ERROR_TRANSLATIONS) {
    if (pattern.test(message)) return translation;
  }
  return null;
}

async function run(button, fn) {
  try {
    setBusy(button, true);
    await fn();
  } catch (err) {
    console.error(err);
    const message = err.shortMessage || err.message || String(err);
    const translated = translateError(message);
    if (translated) {
      log(translated);
    } else if (message.includes("TRANSFER_FROM_FAILED")) {
      log("TRANSFER_FROM_FAILED：通常是 USDT 地址/Router 地址不匹配、USDT 余额不足、授权不足，或当前链不是该 Router 所在网络。请先确认 Mint 模式、USDT 地址、Pancake Router 和钱包网络一致。");
    } else {
      log(message);
    }
  } finally {
    setBusy(button, false);
  }
}
