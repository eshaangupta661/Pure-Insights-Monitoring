import { config } from './config.js';
import { server } from './server.js';

server.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
});
