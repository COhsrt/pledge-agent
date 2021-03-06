const superagent = require('superagent');
const JSONbig = require('json-bigint');
const eventBus = require('../services/event-bus');
const Base = require('./base');

class BOOMWallet extends Base {
  constructor({
    walletUrl,
    pledgeThreshold = 0,
    accountIdToPassPhrase,
    pledgeTo,
    sendThreshold = 0,
    sendTo,
    sendMessage = null,
    moveOtherPledges = false,
    maxPledge,
    coinsToKeepInWallet = 0,
  }) {
    super();
    this.walletUrl = walletUrl;
    this.pledgeThreshold = pledgeThreshold;
    this.pledgeTo = pledgeTo;
    this.sendThreshold = sendThreshold;
    this.sendTo = sendTo;
    this.sendMessage = sendMessage;
    this.moveOtherPledges = moveOtherPledges;
    this.maxPledge = maxPledge;
    this.accounts = Object.keys(accountIdToPassPhrase).map(id => ([id, accountIdToPassPhrase[id]]));
    this.standardFee = 0.0147;
    this.symbol = 'BOOM';
    this.coinsToKeepInWallet = coinsToKeepInWallet;
  }

  async init() {
    await super.init();

    await this.updateStandardFee();
    setInterval(this.updateStandardFee.bind(this), 60 * 1000);

    await this.checkBalancesAndRePledge();
    setInterval(this.checkBalancesAndRePledge.bind(this), 10 * 60 * 1000);
  }

  async checkBalancesAndRePledge() {
    if (this.movingPledge) {
      return;
    }
    try {
      this.movingPledge = true;
      let createdPledges = false;
      let sentCoins = false;
      await Promise.all(this.accounts.map(async ([accountId, secretPhrase]) => {
        if (this.moveOtherPledges) {
          await this.moveOutdatedPledges(accountId, secretPhrase);
        }
        const balance = await this.getBalance(accountId);
        const pledges = await this.getPledgesFromAccount(accountId);
        const coinsToKeepInWallet = Math.max((this.standardFee * pledges.length) + (this.standardFee * 2), this.coinsToKeepInWallet);
        if (balance < coinsToKeepInWallet) {
          return;
        }
        const toDistribute = parseFloat((balance - coinsToKeepInWallet).toFixed(8));
        let toPledge = parseFloat((toDistribute * this.pledgeToPercentage).toFixed(8));
        if (this.maxPledge !== undefined && this.pledgeTo) {
          const currentPledge = await this.getPledgedAmount(accountId, this.pledgeTo[0]);
          toPledge = Math.min(Math.max((this.maxPledge - currentPledge), 0), toPledge);
        }
        if (toPledge > 0 && toPledge > this.pledgeThreshold) {
          eventBus.publish('log/info', `${this.symbol} | ${accountId} | Creating pledge of ${toPledge} ${this.symbol} to ${this.pledgeTo[0]} ..`);
          createdPledges = true;
          try {
            await this.createPledge(this.pledgeTo[0], toPledge, accountId, secretPhrase);
            await this.waitForUnconfirmedTransactions(accountId);
          } catch (err) {
            eventBus.publish('log/error', `${this.symbol} | ${accountId} | Failed creating pledge of ${toPledge} ${this.symbol} to ${this.pledgeTo[0]}: ${err.message}`);
          }
        }
        let toSend = parseFloat((toDistribute * this.sendToPercentage).toFixed(8));
        if (toSend > 0.0001 && toSend > this.sendThreshold) {
          eventBus.publish('log/info', `${this.symbol} | ${accountId} | Sending ${toSend} ${this.symbol} to ${this.sendTo[0]} ..`);
          sentCoins = true;
          try {
            await this.sendCoins(this.sendTo[0], toSend, accountId, secretPhrase);
            await this.waitForUnconfirmedTransactions(accountId);
          } catch (err) {
            eventBus.publish('log/error', `${this.symbol} | ${accountId} | Failed sending ${toSend} ${this.symbol} to ${this.sendTo[0]}: ${err.message}`);
          }
        }
      }));
      if (createdPledges) {
        eventBus.publish('log/info', `${this.symbol} | Done pledging to ${this.pledgeTo[0]}`);
      }
      if (sentCoins) {
        eventBus.publish('log/info', `${this.symbol} | Done sending to ${this.sendTo[0]}`);
      }
      this.movingPledge = false;
    } catch (err) {
      this.movingPledge = false;
      eventBus.publish('log/error', `${this.symbol} | Error: ${err.message}`);
    }
  }

  async moveOutdatedPledges(accountId, secretPhrase) {
    if (!this.pledgeTo) {
      return;
    }
    const outDatedPledges = await this.getOutDatedPledges(accountId, this.pledgeTo[0]);
    if (outDatedPledges.length === 0) {
      return;
    }
    const balance = await this.getBalance(accountId);
    if (balance < (outDatedPledges.length * this.standardFee)) {
      eventBus.publish('log/error', `${this.symbol} | Account ${accountId} doesn't have enough funds to cover the pledge canceling, skipping ..`);
      return;
    }
    await this.cancelPledges(outDatedPledges, accountId, secretPhrase);
    const hadUnconfirmedTxs = await this.waitForUnconfirmedTransactions(accountId);
    if (outDatedPledges.length > 0 || hadUnconfirmedTxs) {
      eventBus.publish('log/info', `${this.symbol} | ${accountId} | Waiting one more block so all canceled pledges are accounted for ..`);
      await this.waitNBlocks(1);
    }
  }

  async waitNBlocks(blocksToWait) {
    const initialHeight = await this.getCurrentHeight();
    let currentHeight = initialHeight;
    while(currentHeight < initialHeight + blocksToWait) {
      await new Promise(resolve => setTimeout(resolve, 5 * 1000));
      currentHeight = await this.getCurrentHeight();
    }
  }

  async waitForUnconfirmedTransactions(accountId) {
    let unconfirmedTransactions = await this.getUnconfirmedTransactions(accountId);
    if (unconfirmedTransactions.length === 0) {
      return false;
    }
    eventBus.publish('log/info', `${this.symbol} | ${accountId} | Waiting for all unconfirmed transactions ..`);
    while(unconfirmedTransactions.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 10 * 1000));
      unconfirmedTransactions = await this.getUnconfirmedTransactions(accountId);
    }

    return true;
  }

  async getOutDatedPledges(accountId, pledgeDestination) {
    const pledges = await this.getPledgesFromAccount(accountId);

    return pledges.filter(pledge => pledge.recipient !== pledgeDestination);
  }

  async cancelPledges(pledges, accountId, secretPhrase) {
    for (let pledge of pledges) {
      eventBus.publish('log/info', `${this.symbol} | ${accountId} | Canceling pledge ${pledge.order} of ${parseInt(pledge.amountNQT, 10) / Math.pow(10, 8)} ${this.symbol} to ${pledge.recipient} ..`);
      await this.cancelPledge(pledge.order, secretPhrase);
      await this.waitNBlocks(1);
    }
  }

  async updateStandardFee() {
    try {
      const fees = await this.doApiCall('suggestFee');
      this.standardFee = parseInt(fees.standard, 10) / Math.pow(10, 8);
    } catch (err) {
      eventBus.publish('log/error', `${this.symbol} | Error: ${err.message}`);
    }
  }

  async getPledgesFromAccount(account) {
    return this.doApiCall('getPledgesByAccount', {
      account,
    });
  }

  async getPledgedAmount(account, pledgeDestination) {
    const pledges = await this.getPledgesFromAccount(account);

    return pledges
      .filter(pledge => pledge.recipient === pledgeDestination)
      .map(pledge => parseInt(pledge.amountNQT, 10) / Math.pow(10, 8))
      .reduce((acc, curr) => acc + curr, 0);
  }

  async createPledge(recipient, amount, account, secretPhrase) {
    return this.doApiCall('createPledge', {
      recipient,
      amountNQT: Math.round(amount * Math.pow(10, 8)),
      secretPhrase,
      feeNQT: Math.round(this.standardFee * Math.pow(10, 8)),
      deadline: 150,
    }, 'post');
  }

  async sendCoins(recipient, amount, account, secretPhrase) {
    const config = {
      recipient,
      amountNQT: Math.round(amount * Math.pow(10, 8)),
      secretPhrase,
      feeNQT: Math.round(this.standardFee * Math.pow(10, 8)),
      deadline: 150,
    };
    if (this.sendMessage) {
      config.message = this.sendMessage;
    }
    return this.doApiCall('sendMoney', config, 'post');
  }

  async cancelPledge(txId, secretPhrase) {
    let res = await this.doApiCall('cancelPledge', {
      order: txId,
      secretPhrase,
      feeNQT: Math.round(this.standardFee * Math.pow(10, 8)),
      deadline: 150,
    }, 'post');

    while(res.error) {
      await new Promise(resolve => setTimeout(resolve, 10 * 1000));

      res = await this.doApiCall('cancelPledge', {
        order: txId,
        secretPhrase,
        feeNQT: Math.round(this.standardFee * Math.pow(10, 8)),
        deadline: 150,
      }, 'post');
    }

    return res;
  }

  async getBalance(account) {
    const balanceData = await this.doApiCall('getBalance', {
      account,
    });

    return parseInt(balanceData.balanceNQT, 10) / Math.pow(10, 8);
  }

  async getUnconfirmedTransactions(account) {
    const res = await this.doApiCall('getUnconfirmedTransactions', {
      account,
    });

    return res.unconfirmedTransactions;
  }

  async getCurrentHeight() {
    const miningInfo = this.doApiCall('getMiningInfo');

    return parseInt(miningInfo.height, 10);
  }

  async doApiCall(requestType, params = {}, method = 'get') {
    const queryParams = Object.assign(params, {requestType});
    const res = await superagent[method](`${this.walletUrl}/boom`).query(queryParams);
    const result = JSONbig.parse(res.text);
    if (result.errorCode || result.errorDescription) {
      throw new Error(result.errorDescription || JSON.stringify(result));
    }

    return result;
  }
}

module.exports = BOOMWallet;
