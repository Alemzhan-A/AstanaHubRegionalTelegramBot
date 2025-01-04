const http = require('http');
const port = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running');
});
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs').promises;

class InstagramTelegramBot {
    constructor() {
        try {
            if (!process.env.TELEGRAM_BOT_TOKEN) {
                throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables');
            }
            server.listen(port, () => {
                console.log(`HTTP server is running on port ${port}`);
            });

            if (!process.env.TELEGRAM_BOT_TOKEN) {
                throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables');
            }
        
            
            this.telegramBot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
                polling: true,
                onlyFirstMatch: true,
                request: {
                    timeout: 30000
                }
            });

            server.on('error', (error) => {
                console.error('HTTP server error:', error);
                this.shutdown();
            });

            this.telegramBot.on('polling_error', (error) => {
                console.error('Telegram polling error:', error);
                if (error.code === 'ETELEGRAM') {
                    console.error('Critical Telegram API error. Check your token and permissions.');
                }
            });

            this.telegramBot.on('error', (error) => {
                console.error('Telegram bot error:', error);
            });

            process.on('uncaughtException', (error) => {
                console.error('Uncaught Exception:', error);
                this.shutdown();
            });

            process.on('unhandledRejection', (error) => {
                console.error('Unhandled Promise Rejection:', error);
                this.shutdown();
            });

            this.lastCheckedPostTimestamps = {};
            this.accounts = [];
            this.settings = {};
            this.init();
        } catch (error) {
            console.error('Error in bot initialization:', error);
            process.exit(1);
        }
    }

    async shutdown() {
        console.log('Shutting down gracefully...');
        try {
            await this.telegramBot.stopPolling();
            console.log('Bot polling stopped');

            server.close(() => {
                console.log('HTTP server closed');
                process.exit(1);
            });
        } catch (error) {
            console.error('Error during shutdown:', error);
            process.exit(1);
        }
    }

    async init() {
        await this.loadConfig();
        this.setupHandlers();
        this.startAutoSync();
    }

    async loadConfig() {
        try {
            const data = await fs.readFile('accounts.json', 'utf8');
            const config = JSON.parse(data);
            this.accounts = config.accounts.filter(account => account.enabled);
            this.settings = config.settings;
            console.log(`Loaded ${this.accounts.length} accounts`);

            try {
                const timestampsData = await fs.readFile('timestamps.json', 'utf8');
                const parsedTimestamps = JSON.parse(timestampsData);
                this.lastCheckedPostTimestamps = Object.keys(parsedTimestamps).reduce((acc, key) => {
                    acc[key] = parsedTimestamps[key] ? new Date(parsedTimestamps[key]) : null;
                    return acc;
                }, {});
                console.log('Loaded saved timestamps:', this.lastCheckedPostTimestamps);
            } catch (e) {
                console.log('No saved timestamps found, initializing empty');
                this.lastCheckedPostTimestamps = {};
            }

            this.accounts.forEach(account => {
                if (!this.lastCheckedPostTimestamps[account.instagram_business_id]) {
                    this.lastCheckedPostTimestamps[account.instagram_business_id] = null;
                }
            });
        } catch (error) {
            console.error('Error in config:', error);
            process.exit(1);
        }
    }

    async saveTimestamps() {
        try {
            const timestampsToSave = Object.keys(this.lastCheckedPostTimestamps).reduce((acc, key) => {
                acc[key] = this.lastCheckedPostTimestamps[key]?.toISOString() || null;
                return acc;
            }, {});
            
            await fs.writeFile('timestamps.json', JSON.stringify(timestampsToSave, null, 2));
            console.log('Timestamps saved successfully');
        } catch (error) {
            console.error('Error saving timestamps:', error);
        }
    }

    setupHandlers() {
        this.telegramBot.onText(/\/start/, (msg) => {
            this.telegramBot.sendMessage(msg.chat.id, 'Bot turned on');
        });
    }

    startAutoSync() {
        console.log('Automatic sync started');
        this.checkAllAccounts();

        setInterval(() => {
            this.checkAllAccounts();
        }, this.settings.check_interval);
    }

    async checkAllAccounts() {
        for (const account of this.accounts) {
            try {
                console.log(`\nChecking account: ${account.name}`);
                const posts = await this.getInstagramPosts(account);

                if (!posts.length) {
                    console.log(`No posts for ${account.name}`);
                    continue;
                }

                const sortedPosts = posts.sort((a, b) =>
                    new Date(b.timestamp) - new Date(a.timestamp)
                );

                const lastTimestamp = this.lastCheckedPostTimestamps[account.instagram_business_id];
                const currentTimestamp = new Date(sortedPosts[0].timestamp);

                console.log(`Current timestamp for ${account.name}:`, currentTimestamp);
                console.log(`Last saved timestamp for ${account.name}:`, lastTimestamp);

                if (!lastTimestamp) {
                    this.lastCheckedPostTimestamps[account.instagram_business_id] = currentTimestamp;
                    console.log(`Initializing timestamp for ${account.name}:`, currentTimestamp);
                    await this.saveTimestamps();
                    continue;
                }

                const newPosts = sortedPosts.filter(post => {
                    const postDate = new Date(post.timestamp);
                    return postDate.getTime() > lastTimestamp.getTime();
                });

                if (newPosts.length > 0) {
                    console.log(`Found ${newPosts.length} new posts for ${account.name}`);

                    for (const post of newPosts) {
                        await this.sendPost(post, account);
                        await new Promise(resolve => setTimeout(resolve, this.settings.retry_delay));
                    }

                    this.lastCheckedPostTimestamps[account.instagram_business_id] = currentTimestamp;
                    await this.saveTimestamps();
                    console.log(`Updated timestamp for ${account.name} to:`, currentTimestamp);
                } else {
                    console.log(`No new posts for ${account.name}`);
                }

            } catch (error) {
                console.error(`Error in ${account.name}:`, error);
            }

            await new Promise(resolve => setTimeout(resolve, this.settings.retry_delay));
        }
    }

    async getInstagramPosts(account) {
        try {
            if (!account.instagram_access_token) {
                throw new Error(`Instagram access token not found for ${account.name}`);
            }

            const response = await axios.get('https://graph.facebook.com/v21.0/me/accounts', {
                params: {
                    access_token: account.instagram_access_token
                }
            });

            if (!response.data.data || response.data.data.length === 0) {
                console.error(`Facebook page not found for ${account.name}`);
                return [];
            }

            const pageId = response.data.data[0].id;
            const instagramResponse = await axios.get(`https://graph.facebook.com/v21.0/${pageId}`, {
                params: {
                    fields: 'instagram_business_account',
                    access_token: account.instagram_access_token
                }
            });

            if (!instagramResponse.data.instagram_business_account) {
                console.error(`Instagram page not found for ${account.name}`);
                return [];
            }

            const instagramBusinessId = instagramResponse.data.instagram_business_account.id;
            const mediaResponse = await axios.get(`https://graph.facebook.com/v21.0/${instagramBusinessId}/media`, {
                params: {
                    fields: 'media_type,media_url,thumbnail_url,caption,permalink,timestamp',
                    access_token: account.instagram_access_token
                }
            });

            console.log(`Got ${mediaResponse.data.data.length} posts for ${account.name}`);
            return mediaResponse.data.data || [];

        } catch (error) {
            console.error(`Error in Instagram API for ${account.name}:`, error);
            if (error.response?.data?.error?.message) {
                console.error('API Error details:', error.response.data.error);
            }
            return [];
        }
    }

    async sendPost(post, account) {
        try {
            const MAX_MESSAGE_LENGTH = 4096;
            const MAX_RETRY_ATTEMPTS = 3;
            const RETRY_DELAY = 5000;
            const caption = post.caption ? post.caption.substring(0, MAX_MESSAGE_LENGTH) : '';

            const retry = async (fn, attempts = MAX_RETRY_ATTEMPTS) => {
                for (let i = 0; i < attempts; i++) {
                    try {
                        return await fn();
                    } catch (error) {
                        if (i === attempts - 1) throw error;
                        console.log(`Retry attempt ${i + 1} of ${attempts}`);
                        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                    }
                }
            };

            switch (post.media_type) {
                case 'VIDEO':
                    console.log('Sending Video');
                    await retry(async () => {
                        await this.telegramBot.sendVideo(
                            account.telegram_chat_id,
                            post.media_url,
                            {
                                thumb: post.thumbnail_url
                            }
                        );
                    });

                    if (caption) {
                        await retry(async () => {
                            await this.telegramBot.sendMessage(
                                account.telegram_chat_id,
                                caption,
                                { parse_mode: 'HTML' }
                            );
                        });
                    }
                    break;

                case 'IMAGE':
                    console.log('Sending Photo');
                    await retry(async () => {
                        await this.telegramBot.sendPhoto(
                            account.telegram_chat_id,
                            post.media_url
                        );
                    });
                    if (caption) {
                        await retry(async () => {
                            await this.telegramBot.sendMessage(
                                account.telegram_chat_id,
                                `${caption}`,
                                { parse_mode: 'HTML' }
                            );
                        });
                    }
                    break;

                case 'CAROUSEL_ALBUM':
                    console.log('Carousel processing');
                    const carouselResponse = await axios.get(`https://graph.facebook.com/v21.0/${post.id}/children`, {
                        params: {
                            fields: 'media_type,media_url,thumbnail_url',
                            access_token: account.instagram_access_token
                        }
                    });

                    if (carouselResponse.data && carouselResponse.data.data) {
                        const mediaGroup = [];
                        const videos = [];

                        for (const item of carouselResponse.data.data) {
                            if (item.media_type === 'VIDEO') {
                                videos.push({
                                    url: item.media_url,
                                    thumb: item.thumbnail_url
                                });
                            } else {
                                mediaGroup.push({
                                    type: 'photo',
                                    media: item.media_url
                                });
                            }
                        }

                        if (mediaGroup.length > 0) {
                            await retry(async () => {
                                await this.telegramBot.sendMediaGroup(
                                    account.telegram_chat_id,
                                    mediaGroup
                                );
                            });
                        }
                        if (caption) {
                            await retry(async () => {
                                await this.telegramBot.sendMessage(
                                    account.telegram_chat_id,
                                    `${caption}`,
                                    { parse_mode: 'HTML' }
                                );
                            });
                        }
                    }
                    break;

                default:
                    console.log(`unable to get this type of media: ${post.media_type}`);
            }
        } catch (error) {
            console.error(`Error in sending post for ${account.name}:`, error);
            if (error.response) {
                console.error('Error response:', {
                    status: error.response.status,
                    data: error.response.data
                });
            }
            throw error;
        }
    }
}

const bot = new InstagramTelegramBot();
