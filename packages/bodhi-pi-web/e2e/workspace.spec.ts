import { expect, test } from "./fixtures";

// Override the default seed so the mount path is predictable (`/mnt/demo`).
test.use({ workspaceSeed: { name: "demo", files: { "/readme.txt": "hello world" } } });

test("M7 seeded workspace mounts at /mnt/<name> and chat reaches idle", async ({ chat }) => {
	await test.step("boot to idle", async () => {
		await chat.goto();
		await chat.waitForState("idle", 60_000);
	});

	await test.step("status bar reflects the mount path", async () => {
		await expect(chat.statusBar).toHaveAttribute("data-mount-path", "/mnt/demo");
	});

	await test.step("agent can read seeded file via the read tool", async () => {
		await chat.send(
			"Use the read tool to read /mnt/demo/readme.txt. Reply with the file's content verbatim and nothing else.",
		);
		await chat.waitForState("streaming");
		await chat.waitForState("idle", 60_000);
		expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("hello world");
	});
});
