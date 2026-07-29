const { Pool } = require('pg');
const { initAuthCreds } = require('@whiskeysockets/baileys');

class PostgresAuthState {
    constructor(connectionString) {
        this.pool = new Pool({
            connectionString,
            ssl: { rejectUnauthorized: false }
        });
    }

    async init() {
        const client = await this.pool.connect();
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS baileys_auth (
                    id VARCHAR(100) PRIMARY KEY,
                    value JSONB NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
        } finally {
            client.release();
        }
    }

    async read(id) {
        const result = await this.pool.query('SELECT value FROM baileys_auth WHERE id = $1', [id]);
        return result.rows[0]?.value || null;
    }

    async write(id, value) {
        await this.pool.query(
            `INSERT INTO baileys_auth (id, value)
             VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE
             SET value = $2, updated_at = CURRENT_TIMESTAMP`,
            [id, JSON.stringify(value)]
        );
    }

    async remove(id) {
        await this.pool.query('DELETE FROM baileys_auth WHERE id = $1', [id]);
    }

    async removeAll() {
        await this.pool.query('DELETE FROM baileys_auth');
    }

    async getState() {
        await this.init();

        let creds = await this.read('creds');
        if (!creds || Object.keys(creds).length === 0) {
            creds = initAuthCreds();
            await this.write('creds', creds);
        }

        const keys = {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) {
                    const value = await this.read(`key:${type}:${id}`);
                    if (value) data[id] = value;
                }
                return data;
            },
            set: async (data) => {
                for (const [type, typeData] of Object.entries(data)) {
                    for (const [id, value] of Object.entries(typeData)) {
                        await this.write(`key:${type}:${id}`, value);
                    }
                }
            },
            del: async (type, ids) => {
                for (const id of ids) {
                    await this.remove(`key:${type}:${id}`);
                }
            },
            clear: async () => {
                await this.removeAll();
            },
            loadAll: async () => {
                const result = await this.pool.query(
                    "SELECT id, value FROM baileys_auth WHERE id LIKE 'key:%'"
                );
                const data = {};
                for (const row of result.rows) {
                    const parts = row.id.split(':');
                    const type = parts[1];
                    const keyId = parts.slice(2).join(':');
                    if (!data[type]) data[type] = {};
                    data[type][keyId] = row.value;
                }
                return data;
            }
        };

        return {
            state: { creds, keys },
            saveCreds: async () => {
                await this.write('creds', creds);
            }
        };
    }
}

module.exports = { PostgresAuthState };
