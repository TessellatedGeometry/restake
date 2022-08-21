import child_process from 'child_process'

/** Amount of time to sleep between runs */
const RUN_DELAY = 2 * 60 // 20 min

/**
 * Wait for the given number of seconds before continuing.
 * 
 * TODO(keefertaylor): Dedupe with other base.mjs
 * 
 * @param seconds The number of seconds to wait.
 */
 const sleep = async (seconds) => {
  const milliseconds = seconds * 1000
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const main = async () => {
  // Get networks and slice into an array.
  const networkNames = process.argv.slice(2, process.argv.length)
  const networks = networkNames.map((networkName) => { return networkName.trim() })
  
  console.log(`Starting restake!`)
  console.log(`Networks: `)
  for (let i = 0; i < networks.length; i++) {
    const network = networks[i]
    console.log(`- ${network}`)
  }
  console.log()

  // Loop indefinitely
  while (true) {
    console.log('Kicking off a round of restake.')

    // Kick off a process for each network
    const childProcessHandles = []
    for (let i = 0; i < networks.length; i++) {
      const network = networks[i]
      console.log(`Kicking off process for ${network}`)

      // Kick off the process
      // See: https://stackoverflow.com/questions/36850616/node-js-run-function-in-child-process      
      const childProcessHandle = child_process.fork(`./scripts/run-autostake-once.mjs`, [network], {stdio: 'overlapped'})
      childProcessHandles.push(childProcessHandle)

      // Set up logging for the child process
      // See: https://stackoverflow.com/questions/14332721/node-js-spawn-child-process-and-get-terminal-output-live
      childProcessHandle.stdout.setEncoding('utf8');
      childProcessHandle.stderr.setEncoding('utf8');
      const logForProcess = (data) => {
        process.stdout.write(`[${network.toUpperCase()}] ${data}`);
      }
      childProcessHandle.stdout.on('data', logForProcess)
      childProcessHandle.stderr.on('data', logForProcess)

      console.log(`Process kicked off!`)
    }

    // Sleep between runs to let the processes churn before kicking again
    console.log(`All processes kicked. Sleeping for about ${Math.ceil(RUN_DELAY / 60)} minutes to let them do their things...`)
    await sleep(RUN_DELAY)

    // Ruthlessly kill any child processes that may still be running
    console.log(`Waking back up and killing any hanging processes`)
    for (let i = 0; i < childProcessHandles.length; i++) {
      console.log(`Killing process ${i}...`)
      const childProcessHandle = childProcessHandles[i]
      childProcessHandle.kill()
      console.log(`Successfully killed process ${i}`)
    }

    console.log("Run complete")
    console.log()
  }
}
main()
