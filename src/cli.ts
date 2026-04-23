import { SwarmCoordinator } from './agents/Coordinator';
import { CIEnvironment } from './adapters/CIEnvironment';

async function main() {
    const taskArg = process.argv[2];
    
    if (!taskArg) {
        console.error("❌ Usage: npx ts-node src/cli.ts <task_description>");
        process.exit(1);
    }

    console.log("=========================================");
    console.log("🤖 NEXUS HEADLESS CLOUD AGENT ACTIVATED");
    console.log("=========================================");

    // 🚀 1. Inject the Headless CI Environment
    const env = new CIEnvironment();
    const workspaceRoot = process.cwd(); // Run in the current terminal directory

    // 2. Setup a console logger instead of a UI webview
    const terminalLogger = (msg: string, stepType?: string, details?: string) => {
        const icon = stepType === 'tool' ? '🔧' : stepType === 'analyze' ? '🧠' : stepType === 'code' ? '💻' : '➡️';
        console.log(`\n${icon} ${msg}`);
        if (details) console.log(`   └─ ${details}`);
    };

    try {
        console.log(`\n🚀 Orchestrating task: "${taskArg}"\n`);
        
        // 3. Execute the Swarm
        const diffs = await SwarmCoordinator.executeTask(
            env,
            taskArg,
            workspaceRoot,
            "No LSP context in CLI mode.", // Optional: Could wire up a standalone LSP server later
            "", // CLI Requirements override
            "", // CLI Design override
            "", // No previous failures
            "precise",
            terminalLogger
        );

        if (!diffs || diffs.length === 0) {
            console.error("\n❌ Swarm Execution Failed.");
            process.exit(1);
        }

        console.log("\n✅ SWARM EXECUTION SUCCESSFUL. The following files were verified and ready to commit:");
        diffs.forEach(diff => {
            console.log(` - ${diff.filepath}`);
        });

    } catch (err: any) {
        console.error(`\n💥 Fatal Error: ${err.message}`);
        process.exit(1);
    }
}

main();