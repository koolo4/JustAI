import dotenv from 'dotenv';
import { App } from './App.js';

export async function bootstrap(): Promise<void> {

    dotenv.config();

    const app = new App();

    await app.start();

}