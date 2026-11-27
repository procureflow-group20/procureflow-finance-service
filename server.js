// Local development: same Express app on your PC (npm run dev). Monthly job: npm run job:rollover
require('dotenv').config();
const app = require('./src/app');

const port = Number(process.env.PORT || 3003);
app.listen(port, () => console.log(`finance-service listening on http://localhost:${port}`));
