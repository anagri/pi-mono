const baseline = Date.UTC(2026, 4, 8);
const ms = baseline - new Date(args[0] + "T00:00:00Z").getTime();
console.log(Math.floor(ms / 86400000));
