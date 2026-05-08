export interface Skill {
	name: string;
	description: string;
	disableModelInvocation: boolean;
	allowedTools?: string[];
	baseDir: string;
	filePath: string;
	body: string;
}

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	"allowed-tools"?: string[];
}
