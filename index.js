/**
 * MOLTR TOKEN LAUNCHER BOT
 * 
 * Monitors Moltbook for !moltr commands and auto-launches tokens on Clanker V4
 * Fee split: 80% to token creator, 20% to deployer (you)
 * 
 * Command format on Moltbook:
 * !moltr $TICKER TokenName "Description here" https://image-url.com/image.png
 * 
 * Example:
 * !moltr $PEPE PepeToken "The legendary frog memecoin" https://i.imgur.com/pepe.png
 */

import { Clanker, POOL_POSITIONS, FEE_CONFIGS } from 'clanker-sdk/v4';
import { createWalletClient, createPublicClient, privateKeyToAccount, http } from 'viem';
import { base } from 'viem/chains';
import fetch from 'node-fetch';

// ============================================
// CONFIGURATION - UPDATE THESE VALUES
// ============================================
const CONFIG = {
    // Your deployer wallet private key (KEEP THIS SECRET!)
    DEPLOYER_PRIVATE_KEY: process.env.DEPLOYER_PRIVATE_KEY || '0x_YOUR_PRIVATE_KEY_HERE',
    
    // Your deployer wallet address (receives 20% of fees)
    DEPLOYER_ADDRESS: process.env.DEPLOYER_ADDRESS || '0x_YOUR_WALLET_ADDRESS_HERE',
    
    // Moltbook API credentials
    MOLTBOOK_API_KEY: process.env.MOLTBOOK_API_KEY || 'your_moltbook_api_key',
    MOLTBOOK_API_URL: 'https://www.moltbook.com/api/v1',
    
    // Polling interval (check for new !moltr commands every 30 seconds)
    POLL_INTERVAL_MS: 30000,
    
    // Chain configuration
    CHAIN: base,
    RPC_URL: process.env.RPC_URL || 'https://mainnet.base.org',
    
    // Fee split (in basis points, 10000 = 100%)
    CREATOR_FEE_BPS: 8000,  // 80% to creator
    DEPLOYER_FEE_BPS: 2000, // 20% to you
};

// ============================================
// CLANKER SDK SETUP
// ============================================
const account = privateKeyToAccount(CONFIG.DEPLOYER_PRIVATE_KEY);

const publicClient = createPublicClient({
    chain: CONFIG.CHAIN,
    transport: http(CONFIG.RPC_URL),
});

const walletClient = createWalletClient({
    account,
    chain: CONFIG.CHAIN,
    transport: http(CONFIG.RPC_URL),
});

const clanker = new Clanker({
    publicClient,
    wallet: walletClient,
});

// ============================================
// MOLTBOOK API HELPERS
// ============================================
const moltbookHeaders = {
    'Authorization': `Bearer ${CONFIG.MOLTBOOK_API_KEY}`,
    'Content-Type': 'application/json',
};

/**
 * Fetch recent posts from Moltbook
 */
async function fetchRecentPosts(limit = 50) {
    try {
        const response = await fetch(
            `${CONFIG.MOLTBOOK_API_URL}/posts?limit=${limit}&sort=newest`,
            { headers: moltbookHeaders }
        );
        
        if (!response.ok) {
            throw new Error(`Moltbook API error: ${response.status}`);
        }
        
        const data = await response.json();
        return data.posts || [];
    } catch (error) {
        console.error('Error fetching posts:', error.message);
        return [];
    }
}

/**
 * Reply to a post on Moltbook
 */
async function replyToPost(postId, content) {
    try {
        const response = await fetch(
            `${CONFIG.MOLTBOOK_API_URL}/comments`,
            {
                method: 'POST',
                headers: moltbookHeaders,
                body: JSON.stringify({
                    post_id: postId,
                    content: content,
                }),
            }
        );
        
        if (!response.ok) {
            throw new Error(`Failed to reply: ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        console.error('Error replying to post:', error.message);
        return null;
    }
}

/**
 * Get user's wallet address from Moltbook profile
 */
async function getUserWalletAddress(username) {
    try {
        const response = await fetch(
            `${CONFIG.MOLTBOOK_API_URL}/users/${username}`,
            { headers: moltbookHeaders }
        );
        
        if (!response.ok) {
            return null;
        }
        
        const data = await response.json();
        return data.user?.wallet_address || null;
    } catch (error) {
        console.error('Error fetching user wallet:', error.message);
        return null;
    }
}

// ============================================
// COMMAND PARSER
// ============================================

/**
 * Parse !moltr command from post content
 * 
 * Format: !moltr $TICKER TokenName "Description" https://image.url https://website.url 0xWalletAddress
 * 
 * Returns: { ticker, name, description, imageUrl, websiteUrl, walletAddress } or null
 */
function parseMoltrCommand(content) {
    // Check if post contains !moltr command
    if (!content.toLowerCase().includes('!moltr')) {
        return null;
    }
    
    // Regex patterns
    const tickerPattern = /\$([A-Z0-9]+)/i;
    const imagePattern = /(https?:\/\/[^\s]+\.(png|jpg|jpeg|gif|webp))/i;
    const descriptionPattern = /"([^"]+)"/;
    const websitePattern = /(https?:\/\/[^\s]+(?<!\.(png|jpg|jpeg|gif|webp)))/gi;
    const walletPattern = /(0x[a-fA-F0-9]{40})/;
    
    // Extract ticker
    const tickerMatch = content.match(tickerPattern);
    if (!tickerMatch) {
        return { error: 'Missing ticker (use $TICKER format)' };
    }
    const ticker = tickerMatch[1].toUpperCase();
    
    // Extract wallet address (0x + 40 hex characters)
    const walletMatch = content.match(walletPattern);
    const walletAddress = walletMatch ? walletMatch[1] : null;
    
    // Validate wallet if provided
    if (!walletAddress) {
        return { error: 'Missing wallet address (use 0x... format)' };
    }
    
    // Extract image URL (must end with image extension)
    const imageMatch = content.match(imagePattern);
    const imageUrl = imageMatch ? imageMatch[1] : null;
    
    // Extract all URLs, then filter out image URLs to find website
    const allUrls = content.match(websitePattern) || [];
    const websiteUrl = allUrls.find(url => 
        !url.match(/\.(png|jpg|jpeg|gif|webp)$/i)
    ) || null;
    
    // Extract description (in quotes)
    const descMatch = content.match(descriptionPattern);
    const description = descMatch ? descMatch[1] : `${ticker} token launched via Molterator on Moltbook`;
    
    // Extract token name (word after ticker, or use ticker as name)
    const afterTicker = content.split(tickerMatch[0])[1] || '';
    const nameMatch = afterTicker.trim().match(/^([A-Za-z0-9]+)/);
    const name = nameMatch ? nameMatch[1] : ticker;
    
    return {
        ticker,
        name,
        description,
        imageUrl,
        websiteUrl,
        walletAddress,
    };
}

// ============================================
// TOKEN DEPLOYMENT
// ============================================

/**
 * Deploy token on Clanker V4 with 80/20 fee split
 */
async function deployToken(tokenData, creatorAddress) {
    console.log(`\n🦞 Deploying token: ${tokenData.name} ($${tokenData.ticker})`);
    console.log(`   Creator: ${creatorAddress}`);
    console.log(`   Description: ${tokenData.description}`);
    console.log(`   Image: ${tokenData.imageUrl || 'none'}`);
    console.log(`   Website: ${tokenData.websiteUrl || 'none'}`);
    
    try {
        // Build social media URLs array
        const socialMediaUrls = ['https://moltbook.com'];
        if (tokenData.websiteUrl) {
            socialMediaUrls.unshift(tokenData.websiteUrl);
        }
        
        const deployConfig = {
            name: tokenData.name,
            symbol: tokenData.ticker,
            tokenAdmin: creatorAddress,
            
            // Token metadata
            metadata: {
                description: tokenData.description,
                socialMediaUrls: socialMediaUrls,
            },
            
            // Context for tracking
            context: {
                interface: 'Molterator Bot',
                platform: 'moltbook',
            },
            
            // Pool configuration - Standard meme preset
            pool: {
                positions: POOL_POSITIONS.Standard,
            },
            
            // Dynamic fees (recommended)
            fees: FEE_CONFIGS.DynamicBasic,
            
            // Reward recipients - 80% to creator, 20% to deployer
            rewards: {
                recipients: [
                    {
                        recipient: creatorAddress,
                        admin: creatorAddress,
                        bps: CONFIG.CREATOR_FEE_BPS,  // 8000 = 80%
                        token: 'Paired',  // Receive fees in WETH
                    },
                    {
                        recipient: CONFIG.DEPLOYER_ADDRESS,
                        admin: CONFIG.DEPLOYER_ADDRESS,
                        bps: CONFIG.DEPLOYER_FEE_BPS,  // 2000 = 20%
                        token: 'Paired',  // Receive fees in WETH
                    },
                ],
            },
        };
        
        // Add image if provided
        if (tokenData.imageUrl) {
            deployConfig.image = tokenData.imageUrl;
        }
        
        // Deploy the token
        const { txHash, waitForTransaction, error } = await clanker.deploy(deployConfig);
        
        if (error) {
            throw error;
        }
        
        console.log(`   TX Hash: ${txHash}`);
        
        // Wait for deployment to complete
        const { address } = await waitForTransaction();
        
        console.log(`   ✅ Token deployed at: ${address}`);
        console.log(`   🔗 Clanker: https://clanker.world/clanker/${address}`);
        console.log(`   🔗 BaseScan: https://basescan.org/token/${address}`);
        
        return {
            success: true,
            address,
            txHash,
            clankerUrl: `https://clanker.world/clanker/${address}`,
            basescanUrl: `https://basescan.org/token/${address}`,
        };
        
    } catch (error) {
        console.error(`   ❌ Deployment failed: ${error.message}`);
        return {
            success: false,
            error: error.message,
        };
    }
}

// ============================================
// MAIN BOT LOGIC
// ============================================

// Track processed posts to avoid duplicates
const processedPosts = new Set();

/**
 * Process a single !moltr command
 */
async function processMoltrCommand(post) {
    const postId = post.id;
    const author = post.author?.username || post.author;
    const content = post.content;
    
    // Skip if already processed
    if (processedPosts.has(postId)) {
        return;
    }
    processedPosts.add(postId);
    
    console.log(`\n📬 Processing !moltr command from @${author}`);
    console.log(`   Post ID: ${postId}`);
    console.log(`   Content: ${content.substring(0, 100)}...`);
    
    // Parse the command
    const parsed = parseMoltrCommand(content);
    
    if (!parsed) {
        return; // Not a !moltr command
    }
    
    if (parsed.error) {
        // Reply with error
        await replyToPost(postId, `🦞 **Molterator Error**\n\n${parsed.error}\n\n**Correct format:**\n\`!moltr $TICKER TokenName "Description" https://image.png https://website.com 0xYourWalletAddress\``);
        return;
    }
    
    // Use wallet address from command
    const creatorWallet = parsed.walletAddress;
    
    // Reply that we're processing
    await replyToPost(postId, `🦞 **Molterator Processing...**\n\nLaunching **${parsed.name}** ($${parsed.ticker}) on Base via Clanker V4!\n\n👛 Creator wallet: \`${creatorWallet.slice(0, 6)}...${creatorWallet.slice(-4)}\`\n\n⏳ Please wait for deployment confirmation...`);
    
    // Deploy the token
    const result = await deployToken(parsed, creatorWallet);
    
    if (result.success) {
        // Build website link if provided
        const websiteLink = parsed.websiteUrl ? `• [Website](${parsed.websiteUrl})\n` : '';
        
        // Success reply
        const successMessage = `🦞🚀 **TOKEN LAUNCHED!**

**${parsed.name}** ($${parsed.ticker}) is now live on Base!

📍 **Contract:** \`${result.address}\`
👛 **Creator:** \`${parsed.walletAddress}\`

🔗 **Links:**
${websiteLink}• [View on Clanker](${result.clankerUrl})
• [View on BaseScan](${result.basescanUrl})
• [Trade on Uniswap](https://app.uniswap.org/swap?outputCurrency=${result.address}&chain=base)

💰 **Fee Split:**
• 80% → Creator wallet
• 20% → Molterator (deployer)

*The shell protects, but wealth transcends.* 🦞

— Molterator $MOLTR`;
        
        await replyToPost(postId, successMessage);
    } else {
        // Failure reply
        await replyToPost(postId, `🦞 **Molterator Error**\n\nFailed to deploy **${parsed.name}** ($${parsed.ticker})\n\nError: ${result.error}\n\nPlease try again or check your parameters.`);
    }
}

/**
 * Main polling loop
 */
async function pollMoltbook() {
    console.log('🔍 Checking Moltbook for !moltr commands...');
    
    const posts = await fetchRecentPosts(50);
    
    // Filter for posts containing !moltr
    const moltrPosts = posts.filter(post => 
        post.content?.toLowerCase().includes('!moltr') &&
        !processedPosts.has(post.id)
    );
    
    if (moltrPosts.length > 0) {
        console.log(`📌 Found ${moltrPosts.length} new !moltr command(s)`);
        
        // Process each command (sequentially to avoid race conditions)
        for (const post of moltrPosts) {
            await processMoltrCommand(post);
            // Small delay between deployments
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

/**
 * Start the bot
 */
async function startBot() {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🦞 MOLTERATOR TOKEN LAUNCHER BOT 🦞                        ║
║                                                              ║
║   Monitoring Moltbook for !moltr commands                    ║
║   Deploying tokens on Clanker V4 (Base)                      ║
║                                                              ║
║   Fee Split: 80% Creator / 20% Deployer                      ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
    
    console.log('📊 Configuration:');
    console.log(`   Deployer: ${CONFIG.DEPLOYER_ADDRESS}`);
    console.log(`   Poll Interval: ${CONFIG.POLL_INTERVAL_MS / 1000}s`);
    console.log(`   Chain: Base (${CONFIG.CHAIN.id})`);
    console.log('');
    
    // Initial poll
    await pollMoltbook();
    
    // Start polling loop
    setInterval(pollMoltbook, CONFIG.POLL_INTERVAL_MS);
    
    console.log('✅ Bot is running! Press Ctrl+C to stop.\n');
}

// ============================================
// RUN THE BOT
// ============================================
startBot().catch(console.error);
