const pg = require('pg');
const c = new pg.Client();
c.connect().then(async () => {
  await c.query("UPDATE customer_interactions SET interaction_type = 'EDIT' WHERE interaction_type = 'SYSTEM'");
  await c.query("UPDATE customer_interactions SET interaction_type = 'ACTION' WHERE interaction_type = 'MANUAL'");
  console.log('OK');
}).finally(() => c.end());
