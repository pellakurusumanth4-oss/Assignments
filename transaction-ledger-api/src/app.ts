import express from 'express';
import { Handler } from './exceptions/Handler.ts';
import { HttpException } from './exceptions/HttpException.ts';
import { api } from './routes/api.ts';
import { docs } from './routes/docs.ts';

export const app = express();

app.disable('x-powered-by');

app.use(express.json());

app.use('/api', docs);
app.use('/api', api);

app.use(() => {
  throw new HttpException(404, 'Route not found');
});

app.use(Handler);
