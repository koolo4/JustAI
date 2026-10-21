import dotenv from 'dotenv';
import { App } from './App.js';
import { configureProxy } from '../infrastructure/network/proxy.js';

export async function bootstrap(): Promise<void> {

    dotenv.config();

    const proxy = configureProxy(process.env);

    if (proxy) {
        console.log(`Outgoing requests go through proxy ${proxy.url} (except ${proxy.noProxy})`);
    }

    const app = new App();

    await app.start();

}