import { Command } from "commander";
import { CliError, ExitCode, formatError } from "./utils/error.js";
import { logger } from "./utils/logger.js";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerPlanCommand } from "./commands/plan.js";
import { registerValidateCommand } from "./commands/validate.js";
import { registerReportCommand } from "./commands/report.js";
import { registerVisualizeCommand } from "./commands/visualize.js";
import { registerMigrateCommand } from "./commands/migrate.js";

const program = new Command();

program
  .name("tf-state-mover")
  .description("Analyze Terraform HCL files and generate migration plans")
  .version("0.1.0")
  .option("-o, --output-dir <dir>", "Output directory", "./output")
  .option("--config <path>", "Path to .tf-mover.yaml config file")
  .option("--dry-run", "Dry run mode")
  .option("-v, --verbose", "Verbose output");

registerAnalyzeCommand(program);
registerPlanCommand(program);
registerValidateCommand(program);
registerReportCommand(program);
registerVisualizeCommand(program);
registerMigrateCommand(program);

async function main() {
  try {
    await program.parseAsync();
  } catch (error: unknown) {
    if (error instanceof CliError) {
      logger.error(`Error: ${error.message}`);
      process.exitCode = error.exitCode;
    } else {
      logger.error(`Unexpected error: ${formatError(error)}`);
      if (program.opts().verbose) {
        logger.error(error);
      }
      process.exitCode = ExitCode.INTERNAL_ERROR;
    }
  }
}

main();
