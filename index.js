/**
 * MOLTR TOKEN LAUNCHER BOT
 * 
 * Monitors Moltbook for !moltr commands and auto-launches tokens on Clanker V4
 * Fee split: 80% to token creator, 20% to deployer (you)
 * 
 * Command format on Moltbook:
 * !moltr $TICKER TokenName "Description" https://image.png https://website.com 0xWallet
 */

import { Clanker } from 'clanker-sdk/v4';
import { createWalletClient, createPublicClient, privateKeyToAccount, http } from 'viem';
import { base } from 'viem/chains';

// ============================================
// CONFIGURATION - UPDATE THESE VALUES
// ============================================
const CONFIG = {
    DEPLOYER_PRIVATE_KEY: process.env.DEPLOYER_PRIVATE_KEY || '0x_YOUR_PRIVATE_KEY_HERE',
    DEPLOYER_ADDRESS: process.env.DEPLOYER_ADDRESS || '0x_YOUR_WALLET_ADDRESS_HERE',
    MOLTBOOK_API_KEY: process.env.MOLTBOOK_API_KEY || 'your_moltbook_api_key',
    MOLTBOOK_API_URL: 'https://www.moltbook.com/api/v1',
    POLL_INTERVAL_MS: 30000,
    CHAIN: base,
    RPC_URL: process.env.RPC_URL || 'https://mainnet.base.org',
    CREATOR_FEE_BPS: 8000,
    DEPLOYER_FEE_BPS: 2000,
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

async function fetchRecentPosts(limit = 50) {
    try {
        const response = await fetch(
            `${CONFIG.MOLTBOOK_API_URL}/posts?limit=${limit}&sort=newest`,
            { headers: moltbookHeaders }
        );
        if (!response.ok) throw new Error(`Moltbook API error: ${response.status}`);
        const data = await response.json();
        return data.posts || [];
    } catch (error) {
        console.error('Error fetching posts:', error.message);
        return [];
    }
}

async function replyToPost(postId, content) {
    try {
        const response = await fetch(
            `${CONFIG.MOLTBOOK_API_URL}/comments`,
            {
                method: 'POST',
                headers: moltbookHeaders,
                body: JSON.stringify({ post_id: postId, content }),
            }
        );
        if (!response.ok) throw new Error(`Failed to reply: ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error('Error replying to post:', error.message);
        return null;
    }
}

// ============================================
// COMMAND PARSER
// ============================================
function parseMoltrCommand(content) {
    if (!content.toLowerCase().includes('!moltr')) return null;
    
    const tickerPattern = /\$([A-Z0-9]+)/i;
    const imagePattern = /(https?:\/\/[^\s]+\.(png|jpg|jpeg|gif|webp))/i;
    const descriptionPattern = /"([^"]+)"/;
    const walletPattern = /(0x[a-fA-F0-9]{40})/;
    
    const tickerMatch = content.match(tickerPattern);
    if (!tickerMatch) return { error: 'Missing ticker (use $TICKER format)' };
    const ticker = tickerMatch[1].toUpperCase();
    
    const walletMatch = content.match(walletPattern);
    if (!walletMatch) return { error: 'Missing wallet address (use 0x... format)' };
    const walletAddress = walletMatch[1];
    
    const imageMatch = content.match(imagePattern);
    const imageUrl = imageMatch ? imageMatch[1] : null;
    
    // Find website URL (any URL that's not an image)
    const urlPattern = /https?:\/\/[^\s]+/gi;
    const allUrls = content.match(urlPattern) || [];
    const websiteUrl = allUrls.find(url => 
        !url.match(/\.(png|jpg|jpeg|gif|webp)$/i)
    ) || null;
    
    const descMatch = content.match(descriptionPattern);
    const description = descMatch ? descMatch[1] : `${ticker} token launched via Molterator on Moltbook`;
    
    const afterTicker = content.split(tickerMatch[0])[1] || '';
    const nameMatch = afterTicker.trim().match(/^([A-Za-z0-9]+)/);
    const name = nameMatch ? nameMatch[1] : ticker;
    
    return { ticker, name, description, imageUrl, websiteUrl, walletAddress };
}

// ============================================
// TOKEN DEPLOYMENT
// ============================================
async function deployToken(tokenData, creatorAddress) {
    console.log(`\n🦞 Deploying token: ${tokenData.name} ($${tokenData.ticker})`);
    console.log(`   Creator: ${creatorAddress}`);
    console.log(`   Description: ${tokenData.description}`);
    console.log(`   Image: ${tokenData.imageUrl || 'none'}`);
    console.log(`   Website: ${tokenData.websiteUrl || 'none'}`);
    
    try {
        const socialMediaUrls = ['https://moltbook.com'];
        if (tokenData.websiteUrl) socialMediaUrls.unshift(tokenData.websiteUrl);
        
        const deployConfig = {
            name: tokenData.name,
            symbol: tokenData.ticker,
            tokenAdmin: creatorAddress,
            metadata: {
                description: tokenData.description,
                socialMediaUrls: socialMediaUrls,
            },
            context: {
                interface: 'Molterator Bot',
                platform: 'moltbook',
            },
            rewards: {
                recipients: [
                    {
                        recipient: creatorAddress,
                        admin: creatorAddress,
                        bps: CONFIG.CREATOR_FEE_BPS,
                        token: 'Paired',
                    },
                    {
                        recipient: CONFIG.DEPLOYER_ADDRESS,
                        admin: CONFIG.DEPLOYER_ADDRESS,
                        bps: CONFIG.DEPLOYER_FEE_BPS,
                        token: 'Paired',
                    },
                ],
            },
        };
        
        if (tokenData.imageUrl) deployConfig.image = tokenData.imageUrl;
        
        const { txHash, waitForTransaction, error } = await clanker.deploy(deployConfig);
        if (error) throw error;
        
        console.log(`   TX Hash: ${txHash}`);
        const { address } = await waitForTransaction();
        
        console.log(`   ✅ Token deployed at: ${address}`);
        
        return {
            success: true,
            address,
            txHash,
            clankerUrl: `https://clanker.world/clanker/${address}`,
            basescanUrl: `https://basescan.org/token/${address}`,
        };
    } catch (error) {
        console.error(`   ❌ Deployment failed: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// ============================================
// MAIN BOT LOGIC
// ============================================
const processedPosts = new Set();

async function processMoltrCommand(post) {
    const postId = post.id;
    const author = post.author?.username || post.author;
    const content = post.content;
    
    if (processedPosts.has(postId)) return;
    processedPosts.add(postId);
    
    console.log(`\n📬 Processing !moltr command from @${author}`);
    
    const parsed = parseMoltrCommand(content);
    if (!parsed) return;
    
    if (parsed.error) {
        await replyToPost(postId, `🦞 **Molterator Error**\n\n${parsed.error}\n\n**Format:**\n\`!moltr $TICKER TokenName "Description" https://image.png https://website.com 0xYourWallet\``);
        return;
    }
    
    const creatorWallet = parsed.walletAddress;
    
    await replyToPost(postId, `🦞 **Molterator Processing...**\n\nLaunching **${parsed.name}** ($${parsed.ticker}) on Base!\n\n👛 Creator: \`${creatorWallet.slice(0, 6)}...${creatorWallet.slice(-4)}\`\n\n⏳ Please wait...`);
    
    const result = await deployToken(parsed, creatorWallet);
    
    if (result.success) {
        const websiteLink = parsed.websiteUrl ? `• [Website](${parsed.websiteUrl})\n` : '';
        const successMessage = `🦞🚀 **TOKEN LAUNCHED!**

**${parsed.name}** ($${parsed.ticker}) is now live on Base!

📍 **Contract:** \`${result.address}\`
👛 **Creator:** \`${parsed.walletAddress}\`

🔗 **Links:**
${websiteLink}• [Clanker](${result.clankerUrl})
• [BaseScan](${result.basescanUrl})
• [Uniswap](https://app.uniswap.org/swap?outputCurrency=${result.address}&chain=base)

💰 **Fee Split:** 80% Creator / 20% Deployer

— Molterator $MOLTR 🦞`;
        await replyToPost(postId, successMessage);
    } else {
        await replyToPost(postId, `🦞 **Molterator Error**\n\nFailed to deploy **${parsed.name}** ($${parsed.ticker})\n\nError: ${result.error}`);
    }
}

async function pollMoltbook() {
    console.log('🔍 Checking Moltbook for !moltr commands...');
    const posts = await fetchRecentPosts(50);
    const moltrPosts = posts.filter(post => 
        post.content?.toLowerCase().includes('!moltr') && !processedPosts.has(post.id)
    );
    
    if (moltrPosts.length > 0) {
        console.log(`📌 Found ${moltrPosts.length} new !moltr command(s)`);
        for (const post of moltrPosts) {
            await processMoltrCommand(post);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

async function startBot() {
    console.log(`
╔════════════════════════════════════════════════╗
║  🦞 MOLTERATOR TOKEN LAUNCHER BOT 🦞           ║
║  Monitoring Moltbook for !moltr commands       ║
║  Deploying on Clanker V4 (Base)                ║
║  Fee Split: 80% Creator / 20% Deployer         ║
╚════════════════════════════════════════════════╝
    `);
    
    console.log(`📊 Deployer: ${CONFIG.DEPLOYER_ADDRESS}`);
    console.log(`⏱️  Poll Interval: ${CONFIG.POLL_INTERVAL_MS / 1000}s\n`);
    
    await pollMoltbook();
    setInterval(pollMoltbook, CONFIG.POLL_INTERVAL_MS);
    
    console.log('✅ Bot is running!\n');
}

startBot().catch(console.error);
