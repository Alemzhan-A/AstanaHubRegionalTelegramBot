require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs').promises;
const logger = require('./logger');

class InstagramTelegramBot {
    constructor() {
        try {
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

            this.telegramBot.on('polling_error', (error) => {
                logger.error('Telegram polling error:', error);
                if (error.code === 'ETELEGRAM') {
                    logger.error('Critical Telegram API error. Check your token and permissions.');
                }
            });

            this.telegramBot.on('error', (error) => {
                logger.error('Telegram bot error:', error);
            });

            process.on('uncaughtException', (error) => {
                logger.error('Uncaught Exception:', error);
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
            logger.error('Error in bot initialization:', error);
            process.exit(1);
        }
    }

    async shutdown() {
        logger.info('Shutting down gracefully...');
        try {
            await this.telegramBot.stopPolling();
            logger.info('Bot polling stopped');
            process.exit(1);
        } catch (error) {
            logger.error('Error during shutdown:', error);
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
            this.accounts = config.accounts.filter(account => account.enabled).map(account => ({
                ...account,
                lastProcessedPostId: account.lastProcessedPostId || null
            }));
            this.settings = config.settings;
            logger.info(`Loaded ${this.accounts.length} accounts`);

            try {
                const timestampsData = await fs.readFile('timestamps.json', 'utf8');
                const parsedTimestamps = JSON.parse(timestampsData);
                this.lastCheckedPostTimestamps = Object.keys(parsedTimestamps).reduce((acc, key) => {
                    acc[key] = parsedTimestamps[key] ? new Date(parsedTimestamps[key]) : null;
                    return acc;
                }, {});
                logger.info('Loaded saved timestamps:', this.lastCheckedPostTimestamps);
            } catch (e) {
                logger.info('No saved timestamps found, initializing empty');
                this.lastCheckedPostTimestamps = {};
            }

            this.accounts.forEach(account => {
                if (!this.lastCheckedPostTimestamps[account.instagram_business_id]) {
                    this.lastCheckedPostTimestamps[account.instagram_business_id] = null;
                }
            });
        } catch (error) {
            logger.error('Error in config:', error);
            process.exit(1);
        }
    }

    async saveState() {
        try {
            const timestampsToSave = Object.keys(this.lastCheckedPostTimestamps).reduce((acc, key) => {
                acc[key] = this.lastCheckedPostTimestamps[key]?.toISOString() || null;
                return acc;
            }, {});
            await fs.writeFile('timestamps.json', JSON.stringify(timestampsToSave, null, 2));

            const accountsData = {
                accounts: this.accounts,
                settings: this.settings
            };
            await fs.writeFile('accounts.json', JSON.stringify(accountsData, null, 2));

            logger.info('State saved successfully');
        } catch (error) {
            logger.error('Error saving state:', error);
        }
    }

    setupHandlers() {
        this.telegramBot.onText(/\/start/, (msg) => {
            this.telegramBot.sendMessage(msg.chat.id, 'Bot turned on');
        });
    }

    startAutoSync() {
        logger.info('Automatic sync started');
        this.checkAllAccounts();

        setInterval(() => {
            this.checkAllAccounts();
        }, this.settings.check_interval);
    }

    async checkAllAccounts() {
        for (const account of this.accounts) {
            try {
                logger.info(`\nChecking account: ${account.name}`);
                const posts = await this.getInstagramPosts(account);

                if (!posts.length) {
                    logger.info(`No posts for ${account.name}`);
                    continue;
                }

                const sortedPosts = posts.sort((a, b) =>
                    new Date(b.timestamp) - new Date(a.timestamp)
                );

                const lastTimestamp = this.lastCheckedPostTimestamps[account.instagram_business_id];
                const currentTimestamp = new Date(sortedPosts[0].timestamp);

                logger.info(`Current timestamp for ${account.name}:`, currentTimestamp);
                logger.info(`Last saved timestamp for ${account.name}:`, lastTimestamp);

                const lastProcessedPostId = account.lastProcessedPostId;
                if (lastProcessedPostId === sortedPosts[0].id) {
                    logger.info(`Post ${lastProcessedPostId} was already processed for ${account.name}`);
                    continue;
                }

                if (!lastTimestamp) {
                    this.lastCheckedPostTimestamps[account.instagram_business_id] = currentTimestamp;
                    account.lastProcessedPostId = sortedPosts[0].id;
                    await this.saveState();
                    continue;
                }

                const newPosts = sortedPosts.filter(post => {
                    const postDate = new Date(post.timestamp);
                    const timeDiff = Math.abs(postDate.getTime() - lastTimestamp.getTime());
                    return postDate.getTime() > lastTimestamp.getTime() && timeDiff > 60000;
                });

                if (newPosts.length > 0) {
                    logger.info(`Found ${newPosts.length} new posts for ${account.name}`);

                    for (const post of newPosts) {
                        if (post.id !== lastProcessedPostId) {
                            await this.sendPost(post, account);
                            account.lastProcessedPostId = post.id;
                            await this.saveState();
                            await new Promise(resolve => setTimeout(resolve, this.settings.retry_delay));
                        }
                    }

                    this.lastCheckedPostTimestamps[account.instagram_business_id] = currentTimestamp;
                    await this.saveState();
                    logger.info(`Updated timestamp for ${account.name} to:`, currentTimestamp);
                } else {
                    logger.info(`No new posts for ${account.name}`);
                }

            } catch (error) {
                logger.error(`Error in ${account.name}:`, error);
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
                logger.error(`Facebook page not found for ${account.name}`);
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
                logger.error(`Instagram page not found for ${account.name}`);
                return [];
            }

            const instagramBusinessId = instagramResponse.data.instagram_business_account.id;
            const mediaResponse = await axios.get(`https://graph.facebook.com/v21.0/${instagramBusinessId}/media`, {
                params: {
                    fields: 'media_type,media_url,thumbnail_url,caption,permalink,timestamp',
                    access_token: account.instagram_access_token
                }
            });

            logger.info(`Got ${mediaResponse.data.data.length} posts for ${account.name}`);
            return mediaResponse.data.data || [];

        } catch (error) {
            logger.error(`Error in Instagram API for ${account.name}:`, error);
            if (error.response?.data?.error?.message) {
                logger.error('API Error details:', error.response.data.error);
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
                        logger.info(`Retry attempt ${i + 1} of ${attempts}`);
                        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
                    }
                }
            };

            switch (post.media_type) {
                case 'VIDEO':
                    logger.info('Sending Video');
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
                    logger.info('Sending Photo');
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
                    logger.info('Carousel processing');
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
                    logger.info(`unable to get this type of media: ${post.media_type}`);
            }
        } catch (error) {
            logger.error(`Error in sending post for ${account.name}:`, error);
            if (error.response) {
                logger.error('Error response:', {
                    status: error.response.status,
                    data: error.response.data
                });
            }
            throw error;
        }
    }
}

const bot = new InstagramTelegramBot();
