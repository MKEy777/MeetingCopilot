export interface StartLaunchOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
}

export interface StartLaunchCommand {
  command: string;
  args: string[];
}

export function commandForStart(options?: StartLaunchOptions): StartLaunchCommand;
