const birthday = args[0];
if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
	console.error("expected YYYY-MM-DD, got: " + birthday);
} else {
	const today = Date.now();
	const born = new Date(birthday + "T00:00:00Z").getTime();
	console.log(Math.floor((today - born) / 86400000));
}
