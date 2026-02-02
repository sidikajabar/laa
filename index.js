/**
 * MOLTR TOKEN LAUNCHER BOT
 * 
 * Monitors Moltbook for !moltr commands and auto-launches tokens on Clanker V4
 * Fee split: 80% to token creator, 20% to deployer (you)
 * 
 * Command format:
 * !moltr $TICKER TokenName "Description" https://image.png https://website.com 0xWallet
 */

import { createWalletClient, createPublicClient, http, encodeFunctionData, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    DEPLOYER_PRIVATE_KEY: process.env.DEPLOYER_PRIVATE_KEY || '0x_YOUR_PRIVATE_KEY_HERE',
    DEPLOYER_ADDRESS: process.env.DEPLOYER_ADDRESS || '0x_YOUR_WALLET_ADDRESS_HERE',
    MOLTBOOK_API_KEY: process.env.MOLTBOOK_API_KEY || 'your_moltbook_api_key',
    MOLTBOOK_API_URL: 'https://www.moltbook.com/api/v1',
    POLL_INTERVAL_MS: 30000,
    RPC_URL: process.env.RPC_URL || 'https://mainnet.base.org',
    CREATOR_FEE_BPS: 8000,  // 80%
    DEPLOYER_FEE_BPS: 2000, // 20%
};

// Clanker V4 Factory Contract on Base
const CLANKER_FACTORY = '0x375C15db32D28cEcdcAB5C03Ab889bf15cbD2c5E';

// Simplified ABI for token deployment
const CLANKER_ABI = [
    {
        "inputs": [
            {
                "components": [
                    { "name": "name", "type": "string" },
                    { "name": "symbol", "type": "string" },
                    { "name": "image", "type": "string" },
                    { "name": "metadata", "type": "string" },
                    { "name": "context", "type": "string" },
                    { "name": "tokenAdmin", "type": "address" },
                    {
                        "name": "rewardRecipients",
                        "type": "tuple[]",
                        "components": [
                            { "name": "recipient", "type": "address" },
                            { "name": "admin", "type": "address" },
                            { "name": "bps", "type": "uint16" },
                            { "name": "tokenType", "type": "uint8" }
                        ]
                    }
                ],
                "name": "params",
                "type": "tuple"
            }
        ],
        "name": "deployToken",
        "outputs": [{ "name": "token", "type": "address" }],
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

// ============================================
// VIEM SETUP
// ============================================
const account = privateKeyToAccount(CONFIG.DEPLOYER_PRIVATE_KEY);

const publicClient = createPublicClient({
    chain: base,
    transport: http(CONFIG.RPC_URL),
});

const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(CONFIG.RPC_URL),
});

// ============================================
// MOLTBOOK API
// ============================================
const headers = {
    'Authorization': `Bearer ${CONFIG.MOLTBOOK_API_KEY}`,
    'Content-Type': 'application/json',
};

async function fetchRecentPosts(limit = 50) {
    try {
        const res = await fetch(`${CONFIG.MOLTBOOK_API_URL}/posts?limit=${limit}&sort=newest`, { headers });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const data = await res.json();
        return data.posts || [];
    } catch (e) {
        console.error('Fetch error:', e.message);
        return [];
    }
}

async function replyToPost(postId, content) {
    try {
        await fetch(`${CONFIG.MOLTBOOK_API_URL}/comments`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ post_id: postId, content }),
        });
    } catch (e) {
        console.error('Reply error:', e.message);
    }
}

// ============================================
// COMMAND PARSER
// ============================================
function parseMoltrCommand(content) {
    if (!content.toLowerCase().includes('!moltr')) return null;
    
    const tickerMatch = content.match(/\$([A-Z0-9]+)/i);
    if (!tickerMatch) return { error: 'Missing ticker ($TICKER)' };
    
    const walletMatch = content.match(/(0x[a-fA-F0-9]{40})/);
    if (!walletMatch) return { error: 'Missing wallet (0x...)' };
    
    const imageMatch = content.match(/(https?:\/\/[^\s]+\.(png|jpg|jpeg|gif|webp))/i);
    const descMatch = content.match(/"([^"]+)"/);
    
    const urlPattern = /https?:\/\/[^\s]+/gi;
    const allUrls = content.match(urlPattern) || [];
    const websiteUrl = allUrls.find(u => !u.match(/\.(png|jpg|jpeg|gif|webp)$/i)) || null;
    
    const afterTicker = content.split(tickerMatch[0])[1] || '';
    const nameMatch = afterTicker.trim().match(/^([A-Za-z0-9]+)/);
    
    return {
        ticker: tickerMatch[1].toUpperCase(),
        name: nameMatch ? nameMatch[1] : tickerMatch[1].toUpperCase(),
        description: descMatch ? descMatch[1] : `${tickerMatch[1]} launched via Molterator`,
        imageUrl: imageMatch ? imageMatch[1] : '',
        websiteUrl,
        walletAddress: walletMatch[1],
    };
}

// ============================================
// TOKEN DEPLOYMENT
// ============================================
async function deployToken(tokenData, creatorAddress) {
    console.log(`\n🦞 Deploying: ${tokenData.name} ($${tokenData.ticker})`);
    console.log(`   Creator: ${creatorAddress}`);
    
    try {
        // Build metadata JSON
        const metadata = JSON.stringify({
            description: tokenData.description,
            socialMediaUrls: tokenData.websiteUrl ? [tokenData.websiteUrl, 'https://moltbook.com'] : ['https://moltbook.com'],
        });
        
        const context = JSON.stringify({
            interface: 'Molterator Bot',
            platform: 'moltbook',
        });
        
        // Reward recipients: 80% creator, 20% deployer
        const rewardRecipients = [
            {
                recipient: creatorAddress,
                admin: creatorAddress,
                bps: CONFIG.CREATOR_FEE_BPS,
                tokenType: 1, // Paired (WETH)
            },
            {
                recipient: CONFIG.DEPLOYER_ADDRESS,
                admin: CONFIG.DEPLOYER_ADDRESS,
                bps: CONFIG.DEPLOYER_FEE_BPS,
                tokenType: 1, // Paired (WETH)
            },
        ];
        
        const deployParams = {
            name: tokenData.name,
            symbol: tokenData.ticker,
            image: tokenData.imageUrl || '',
            metadata,
            context,
            tokenAdmin: creatorAddress,
            rewardRecipients,
        };
        
        // Send transaction
        const hash = await walletClient.writeContract({
            address: CLANKER_FACTORY,
            abi: CLANKER_ABI,
            functionName: 'deployToken',
            args: [deployParams],
        });
        
        console.log(`   TX: ${hash}`);
        
        // Wait for confirmation
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        
        // Get token address from logs
        const tokenAddress = receipt.logs[0]?.address || 'Check BaseScan';
        
        console.log(`   ✅ Deployed: ${tokenAddress}`);
        
        return {
            success: true,
            address: tokenAddress,
            txHash: hash,
        };
    } catch (e) {
        console.error(`   ❌ Failed: ${e.message}`);
        return { success: false, error: e.message };
    }
}

// ============================================
// MAIN BOT
// ============================================
const processed = new Set();

async function processMoltrCommand(post) {
    const { id, content, author } = post;
    const username = author?.username || author;
    
    if (processed.has(id)) return;
    processed.add(id);
    
    console.log(`\n📬 Processing from @${username}`);
    
    const parsed = parseMoltrCommand(content);
    if (!parsed) return;
    
    if (parsed.error) {
        await replyToPost(id, `🦞 **Error:** ${parsed.error}\n\n**Format:**\n\`!moltr $TICKER Name "Desc" https://img.png https://site.com 0xWallet\``);
        return;
    }
    
    await replyToPost(id, `🦞 **Launching ${parsed.name} ($${parsed.ticker})...**\n\n👛 \`${parsed.walletAddress.slice(0,6)}...${parsed.walletAddress.slice(-4)}\`\n\n⏳ Please wait...`);
    
    const result = await deployToken(parsed, parsed.walletAddress);
    
    if (result.success) {
        const msg = `🦞🚀 **LAUNCHED!**

**${parsed.name}** ($${parsed.ticker})

📍 \`${result.address}\`
👛 \`${parsed.walletAddress}\`

🔗 [Clanker](https://clanker.world/clanker/${result.address}) | [BaseScan](https://basescan.org/token/${result.address}) | [Uniswap](https://app.uniswap.org/swap?outputCurrency=${result.address}&chain=base)

💰 80% Creator / 20% Deployer

— Molterator 🦞`;
        await replyToPost(id, msg);
    } else {
        await replyToPost(id, `🦞 **Failed:** ${result.error}`);
    }
}

async function poll() {
    console.log('🔍 Checking Moltbook...');
    const posts = await fetchRecentPosts(50);
    const moltr = posts.filter(p => p.content?.toLowerCase().includes('!moltr') && !processed.has(p.id));
    
    for (const post of moltr) {
        await processMoltrCommand(post);
        await new Promise(r => setTimeout(r, 5000));
    }
}

async function start() {
    console.log(`
╔═══════════════════════════════════════╗
║  🦞 MOLTERATOR TOKEN LAUNCHER 🦞      ║
║  Clanker V4 on Base                   ║
║  80% Creator / 20% Deployer           ║
╚═══════════════════════════════════════╝
`);
    console.log(`Deployer: ${CONFIG.DEPLOYER_ADDRESS}\n`);
    
    await poll();
    setInterval(poll, CONFIG.POLL_INTERVAL_MS);
    
    console.log('✅ Running!\n');
}

start().catch(console.error);
