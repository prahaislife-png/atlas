import {createHostedHandler} from '../src/hosted/handler.js';

export const config = {maxDuration: 120};
const handler = createHostedHandler();
export default function api(req, res) {
  const route = new URL(req.url, 'https://atlas.invalid').searchParams.get('atlas_path');
  if (route) req.url = '/api/' + route;
  return handler(req, res);
}
