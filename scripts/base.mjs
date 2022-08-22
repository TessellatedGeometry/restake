import fs from 'fs'
import _ from 'lodash'

import { add, bignumber, floor, smaller, smallerEq } from 'mathjs'

import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { Slip10RawIndex, pathToString } from "@cosmjs/crypto";

import { Wallet as EthWallet } from "@ethersproject/wallet";

import { MsgDelegate } from "cosmjs-types/cosmos/staking/v1beta1/tx.js";
import { MsgExec } from "cosmjs-types/cosmos/authz/v1beta1/tx.js";

import Network from '../src/utils/Network.mjs'
import Wallet from '../src/utils/Wallet.mjs';
import AutostakeHealth from "../src/utils/AutostakeHealth.mjs";
import {coin, timeStamp, mapSync, executeSync, overrideNetworks, parseGrants} from '../src/utils/Helpers.mjs'
import EthSigner from '../src/utils/EthSigner.mjs';

import 'dotenv/config'

// Time to wait on an error
const ERROR_DELAY = 1

// Time to wait to not slam nodes
const CONSECUTIVE_REQUEST_DELAY = 1

let sleeptime = 1

/**
 * Wait for the given number of seconds before continuing.
 * 
 * @param seconds The number of seconds to wait.
 */
 const sleep = async (seconds) => {
  const milliseconds = sleeptime * 1000
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
 }

 const errorSleep = async (seconds) => {
  // Increment sleep time
  sleeptime *= 1.2
  timeStamp(`Sleeping for ${sleeptime} seconds...`)
  

  const milliseconds = sleeptime * 1000
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class Autostake {
  constructor(opts){
    this.opts = opts || {}
    this.mnemonic = process.env.MNEMONIC
    if(!this.mnemonic){
      timeStamp('Please provide a MNEMONIC environment variable')
      process.exit()
    }
  }

  async run(networkNames){
    const networks = this.getNetworksData()
    for(const name of networkNames){
      if (name && !networks.map(el => el.name).includes(name)) return timeStamp('Invalid network name:', name)
    }

    // for (let i = 0; i < networks.length; i++) {
    //   const network = networks[i]

    //   if (networkNames && networkNames.length && !networkNames.includes(data.name)) {        
    //     timeStamp(`FYI: Ignoring ${data.name}`)
    //     return
    //   }

    //   const health = new AutostakeHealth(data.healthCheck, { dryRun: this.opts.dryRun })
    //   health.started('⚛')

    //   let client = undefined
    //   while (client === undefined)
    // }

    for (let i = 0; i < networks.length; i++) {
      const data = networks[i]

      if(networkNames && networkNames.length && !networkNames.includes(data.name)) continue
      if(data.enabled === false) continue

      let client
      let health = new AutostakeHealth(data.healthCheck, { dryRun: this.opts.dryRun })
      health.started('⚛')
      try {
        client = await this.getClient(data, health)
      } catch (error) {
        return health.failed('Failed to connect', error.message)
      }

      if(!client) return health.success('Skipping')

      const { restUrl, usingDirectory } = client.network

      timeStamp('Using REST URL', restUrl)

        // if(usingDirectory){
        //   timeStamp('You are using public nodes, script may fail with many delegations. Check the README to use your own')
        //   timeStamp('Delaying briefly to reduce load...')
        //   await new Promise(r => setTimeout(r, (Math.random() * 31) * 1000));
        // }

      try {
        await this.runNetwork(client)
        return health.success(`\nComplete\n`)
      } catch (error) {
        return health.failed('Autostake failed, skipping network', error.message)
      }
    }
  }

  async runNetwork(client){
    timeStamp('Running autostake')
    const { network, health } = client 

    // Retry...
    let balance = undefined
    while (balance === undefined) {
      try {
        balance = await this.checkBalance(client)
      } catch (e) {
        timeStamp(`Error getting balance: ${e}`)
        await errorSleep(ERROR_DELAY)
      }
    }
    if (!balance || smaller(balance, 1_000)) {
      return health.failed('Bot balance is too low')
    }

    timeStamp('Finding delegators...')
    let delegations = undefined
    while (delegations === undefined) {
      try {
        delegations = await this.getDelegations(client)
      } catch (e) {
        timeStamp(`Error getting delegations: ${e}`)
        await errorSleep(ERROR_DELAY)
      }
    }

    // Filter all nonzero delegations
    const nonZeroDelegations = delegations.filter((delegation) => {
      return delegation.balance.amount !== 0
    })

    // Map delegations to addresses
    const addresses = nonZeroDelegations.map((delegation) => {
      return delegation.delegation.delegator_address
    })
  
    timeStamp("Checking", addresses.length, "delegators for grants...")
    let grantedAddresses = undefined
    while (grantedAddresses === undefined) {
      try {
        grantedAddresses = await this.getGrantedAddresses(client, addresses)
      } catch (e) {
        timeStamp(`Error getting granted addresses: ${e}`)
        await errorSleep(ERROR_DELAY)
      }
    }
    timeStamp("Found", grantedAddresses.length, "delegators with valid grants...")

    await this.autostake(client, grantedAddresses)
  }

  async getClient(data, health) {
    let network = new Network(data)
    try {
      await network.load()
    } catch {
      return timeStamp('Unable to load network data for', network.name)
    }

    timeStamp('Starting', network.prettyName)

    const { signer, slip44 } = await this.getSigner(network)
    const wallet = new Wallet(network, signer)
    const botAddress = await wallet.getAddress()

    timeStamp('Bot address is', botAddress)

    if (network.slip44 && network.slip44 !== slip44) {
      timeStamp("!! You are not using the preferred derivation path !!")
      timeStamp("!! You should switch to the correct path unless you have grants. Check the README !!")
    }

    const operator = network.getOperatorByBotAddress(botAddress)

    if (!operator) return timeStamp('Not an operator')

    if (!network.authzSupport) return timeStamp('No Authz support')

    await network.connect()
    if (!network.restUrl) throw new Error('Could not connect to REST API')

    const client = wallet.signingClient
    client.registry.register("/cosmos.authz.v1beta1.MsgExec", MsgExec)

    return {
      network,
      operator,
      health,
      signingClient: client,
      queryClient: network.queryClient
    }
  }

  async getSigner(network){
    let slip44
    if(network.data.autostake?.correctSlip44 || network.slip44 === 60){
      if(network.slip44 === 60) timeStamp('Found ETH coin type')
      slip44 = network.slip44 || 118
    }else{
      slip44 = network.data.autostake?.slip44 || 118
    }
    let hdPath = [
      Slip10RawIndex.hardened(44),
      Slip10RawIndex.hardened(slip44),
      Slip10RawIndex.hardened(0),
      Slip10RawIndex.normal(0),
      Slip10RawIndex.normal(0),
    ];
    slip44 != 118 && timeStamp('Using HD Path', pathToString(hdPath))

    let signer = await DirectSecp256k1HdWallet.fromMnemonic(this.mnemonic, {
      prefix: network.prefix,
      hdPaths: [hdPath]
    });

    if(network.slip44 === 60){
      const ethSigner = EthWallet.fromMnemonic(this.mnemonic);
      signer = EthSigner(signer, ethSigner, network.prefix)
    }

    return { signer, slip44 }
  }

  async checkBalance(client) {
    const balance = await (client.queryClient.getBalance(client.operator.botAddress, client.network.denom))
    timeStamp("Bot balance is", balance.amount, balance.denom)
    return balance.amount
  }

  async getDelegations(client) {
    let batchSize = client.network.data.autostake?.batchQueries || 100

    return await client.queryClient.getAllValidatorDelegations(client.operator.address, batchSize, (pages) => {
      timeStamp("...batch", pages.length)
    })
  }

  async getGrantedAddresses(client, addresses) {
    const { botAddress, address } = client.operator
    
    // Parse through each address
    const results = []
    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i]
      timeStamp(`[${i+1}/${addresses.length}] Examining ${address}`)

      try {
        const grants = await this.getGrants(client, address)
        results.push(grants)

        // Nicely give the node some breathing room
        await sleep(CONSECUTIVE_REQUEST_DELAY)
      } catch (e) {
        timeStamp(`Error getting grants for ${address}: ${e}`)
        await errorSleep(ERROR_DELAY)

        // retry 
        i--
      }     
    }
    timeStamp(`Got ${results.length} results...`)

    // Compact grants
    const compacted = _.compact(results)
    timeStamp(`Compacted to ${compacted.length}`)

    return compacted


    
    // let allGrants
    // try {
    //   allGrants = await client.queryClient.getGranteeGrants(botAddress)
    // } catch (e) {  }
    // let grantCalls = addresses.map(item => {
    //   return async () => {
    //     if(allGrants) return this.parseGrantResponse(allGrants, botAddress, item, address)
    //     try {
    //       return await this.getGrants(client, item)
    //     } catch (error) {
    //       client.health.error(item, 'Failed to get grants', error.message)
    //     }
    //   }
    // })
    // let batchSize = client.network.data.autostake?.batchQueries || 50
    // let grantedAddresses = await mapSync(grantCalls, batchSize, (batch, index) => {
    //   timeStamp('...batch', index + 1)
    // })
    // return _.compact(grantedAddresses.flat())
  }

  async getGrants(client, delegatorAddress) {
    const { botAddress, address } = client.operator
    let timeout = client.network.data.autostake?.delegatorTimeout || 5000
    const result = await client.queryClient.getGrants(botAddress, delegatorAddress, { timeout })
    return this.parseGrantResponse(result, botAddress, delegatorAddress, address)
  }

  parseGrantResponse(grants, botAddress, delegatorAddress, validatorAddress){
    const result = parseGrants(grants, botAddress, delegatorAddress)
    let grantValidators, maxTokens
    if (result.stakeGrant) {
      if (result.stakeGrant.authorization['@type'] === "/cosmos.authz.v1beta1.GenericAuthorization") {
        timeStamp(delegatorAddress, "Using GenericAuthorization, allowed")
        grantValidators = [validatorAddress];
      } else {
        grantValidators = result.stakeGrant.authorization.allow_list.address
        if (!grantValidators.includes(validatorAddress)) {
          timeStamp(delegatorAddress, "Not autostaking for this validator, skipping")
          return undefined
        }
        maxTokens = result.stakeGrant.authorization.max_tokens
      }

      const grant = {
        maxTokens: maxTokens && bignumber(maxTokens.amount),
        validators: grantValidators,
      }
      return { address: delegatorAddress, grant: grant }
    }
  }

  async getAutostakeMessage(client, grantAddress) {
    const { address, grant } = grantAddress

    let timeout = client.network.data.autostake?.delegatorTimeout || 5000
    const withdrawAddress = await client.queryClient.getWithdrawAddress(address, { timeout })
    if(withdrawAddress && withdrawAddress !== address){
      timeStamp(address, 'has a different withdraw address:', withdrawAddress)
      return undefined
    }

    const totalRewards = await this.totalRewards(client, address)

    if(totalRewards === undefined) {
      return undefined
    }

    let autostakeAmount = floor(totalRewards)

    // We'll take any amount of reward, for now.
    // if (smaller(bignumber(autostakeAmount), bignumber(client.operator.minimumReward))) {
    //   timeStamp(address, autostakeAmount, client.network.denom, 'reward is too low, skipping')
    //   return undefined
    // }

    if (grant.maxTokens){
      if(smallerEq(grant.maxTokens, 0)) {
        timeStamp(address, grant.maxTokens, client.network.denom, 'grant balance is empty, skipping')
        return undefined
      }
      if(smaller(grant.maxTokens, autostakeAmount)) {
        autostakeAmount = grant.maxTokens
        timeStamp(address, grant.maxTokens, client.network.denom, 'grant balance is too low, using remaining')
      }
    }

    timeStamp(address, "Can autostake", autostakeAmount, client.network.denom)

    return this.buildRestakeMessage(address, client.operator.address, autostakeAmount, client.network.denom)
  }

  async autostake(client, grantedAddresses) {
    const { network, health } = client
    let batchSize = network.data.autostake?.batchTxs || 50
    timeStamp('Calculating and autostaking in batches of', batchSize)

    // Parse each granted address into a message. A message is either a json object, or undefined.
    const messages = []
    for (let i = 0; i < grantedAddresses.length; i++) {
      const grantedAddress = grantedAddresses[i]
      timeStamp(`[${i+1}/${grantedAddress.length}] Attempting to generate a message for address ${grantedAddress}`)

      try {
        const message = await this.getAutostakeMessage(client, grantedAddress)
        messages.push(message)

        // Nicely pause for a second to not slam nodes too hard.
        await sleep(CONSECUTIVE_REQUEST_DELAY)        
      } catch (e) {
        timeStamp(`Caught error trying to get message: ${e}`)
        await errorSleep(ERROR_DELAY)

        // Retry
        i--
      }
    }
    timeStamp(`Got ${messages.length} messages`)

    // Filter out undefined messages
    const validMessages = messages.filter((message) => { 
      return message !== undefined
    })
    timeStamp(`Got ${validMessages.length} valid messages`)

    // Chunk messages into batches..
    const batches = _.chunk(validMessages, batchSize)
    timeStamp(`Will send ${batches.length} batches`)

    // Send messages in each batch
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]

      try {
        await this.sendMessages(client, batch)
        timeStamp(`Sent batch ${i+1}`)
      } catch (e) {
        timeStamp(`Error sending batch ${i+1}: ${e}`)
        await errorSleep(ERROR_DELAY)

        // Retry
        i--
      }
    }
  }

  async sendInBatches(client, messages, batchSize, total){
    if (messages) {
      this.batch = this.batch.concat(messages)
    }

    const finished = (Object.keys(this.processed).length >= total && this.batch.length > 0)
    if (this.batch.length >= batchSize || finished) {
      const batch = this.batch
      this.batch = []

      const messages = [...this.messages]
      const promise = messages[messages.length - 1] || Promise.resolve()
      const sendTx = promise.then(() => {
        timeStamp('Sending batch', messages.length + 1)
        return this.sendMessages(client, batch)
      })
      this.messages.push(sendTx)
      return sendTx
    }
  }

  async sendMessages(client, messages){
    const execMsg = this.buildExecMessage(client.operator.botAddress, messages)
    const memo = 'REStaked by ' + client.operator.moniker
    const gasModifier = client.network.data.autostake?.gasModifier || 1.1
    const gas = await client.signingClient.simulate(client.operator.botAddress, [execMsg], memo, gasModifier);
    if (this.opts.dryRun) {
      const message = `DRYRUN: Would send ${messages.length} TXs using ${gas} gas`
      timeStamp(message)
      return { message }
    } else {
      const response = await client.signingClient.signAndBroadcast(client.operator.botAddress, [execMsg], gas, memo)
      timeStamp(`Sent in ${response.transactionHash}`)
    }
  }

  buildExecMessage(botAddress, messages) {
    return {
      typeUrl: "/cosmos.authz.v1beta1.MsgExec",
      value: {
        grantee: botAddress,
        msgs: messages
      }
    }
  }

  buildRestakeMessage(address, validatorAddress, amount, denom) {
    return [{
      typeUrl: "/cosmos.staking.v1beta1.MsgDelegate",
      value: MsgDelegate.encode(MsgDelegate.fromPartial({
        delegatorAddress: address,
        validatorAddress: validatorAddress,
        amount: coin(amount, denom)
      })).finish()
    }]
  }

  async totalRewards(client, address) {
    let timeout = client.network.data.autostake?.delegatorTimeout || 5000
    const rewards = await client.queryClient.getRewards(address, { timeout })

    const total = Object.values(rewards).reduce((sum, item) => {
      const reward = item.reward.find(el => el.denom === client.network.denom)
      if (reward && item.validator_address === client.operator.address) {
        return add(sum, bignumber(reward.amount))
      }
      return sum
    }, 0)
    return total
  }

  getNetworksData() {
    const networksData = fs.readFileSync('src/networks.json');
    const networks = JSON.parse(networksData);
    try {
      const overridesData = fs.readFileSync('src/networks.local.json');
      const overrides = overridesData && JSON.parse(overridesData) || {}
      return overrideNetworks(networks, overrides)
    } catch (error) {
      timeStamp('Failed to parse networks.local.json, check JSON is valid', error.message)
      return networks
    }
  }
}
