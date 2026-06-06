import type { Command } from "commander";
import { checkPrerequisites, dryRunMigration } from "../state/tfmigrate-executor.js";
import { CliError, validateFile } from "../utils/error.js";
import { logger } from "../utils/logger.js";

export function registerValidateCommand(program: Command): void {
  program
    .command("validate")
    .description("Validate a migration HCL file using tfmigrate plan (dry-run)")
    .argument("<hcl-file>", "Path to tfmigrate HCL file")
    .option("--tf-binary <binary>", "Terraform binary name", "terraform")
    .action(async (hclFile: string, cmdOpts) => {
      const opts = program.opts();
      const workingDir = opts.outputDir || ".";

      await validateFile(hclFile);

      const prereqs = await checkPrerequisites({ dryRun: true, workingDir, tfBinary: cmdOpts.tfBinary });
      if (!prereqs.terraform) {
        throw new CliError("terraform binary not found in PATH. Install terraform first.");
      }
      if (!prereqs.tfmigrate) {
        throw new CliError("tfmigrate binary not found in PATH. Install tfmigrate first: https://github.com/minamijoyo/tfmigrate");
      }

      const result = await dryRunMigration(hclFile, { dryRun: true, workingDir, tfBinary: cmdOpts.tfBinary });
      if (result.success) {
        logger.log("✓ Migration plan validated successfully");
        logger.log(result.output);
      } else {
        throw new CliError(`Migration plan validation failed:\n${result.error}`);
      }
    });
}
