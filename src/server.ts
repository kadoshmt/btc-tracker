import express, { Request, Response } from 'express';
import axios from 'axios';
import NodeCache from 'node-cache';
import axiosRetry from 'axios-retry';
import moment from 'moment-timezone';

const app = express();
const port = 3000;
axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay });
app.set('view engine', 'ejs');

const priceCache = new NodeCache({ stdTTL: 60000 }); // Cache dura 1000 minutos

// Função auxiliar para converter satoshis para BTC
const satoshisToBTC = (satoshis: number): number => satoshis / 100000000;

// Função auxiliar para buscar o preço histórico do Bitcoin
const fetchHistoricalPrice = async (timestamp: number): Promise<number> => {
  const cacheKey = `price-${timestamp}`;
  const cachedPrice = Number(priceCache.get(cacheKey));
  if (cachedPrice) {
    return cachedPrice;
  }

  try {
    const response = await axios.get(`https://mempool.space/api/v1/historical-price?currency=USD&timestamp=${timestamp}`);
    const priceUSD = response.data.prices[0].USD;
    priceCache.set(cacheKey, priceUSD);
    return priceUSD;
  } catch (error) {
    console.error(`Failed to fetch historical price for timestamp ${timestamp}: ${error}`);
    return 0;
  }
};

// Função auxiliar para buscar o preço atual do Bitcoin
const fetchLatestPrice = async (): Promise<number> => { 
  

  try {
    const response = await axios.get('https://mempool.space/api/v1/prices');
    const priceUSD = response.data.USD;
    return priceUSD;
  } catch (error) {
    console.error(`Failed to fetch the latest price: ${error}`);
    return 0;
  }
};

app.get('/', (req, res) => {
  // Renderiza a página inicial sempre passando objetos currentBalance e currentPriceBalance vazios
  res.render('index', {
      transactions: [],
      address: null,
      currentBalance: 0,  // Valor padrão como zero
      currentPriceBalance: 0  // Valor padrão como zero
  });
});

app.get('/search', async (req, res) => {
  const { address, txid } = req.query;
  try {
      let transactions, addressResponse;
      let currentBalance = 0;  // Valor padrão como zero
      let currentPriceBalance = 0;  // Valor padrão como zero

      if (txid && address) {
          const response = await axios.get(`http://localhost:${port}/address/${address}/${txid}`);
          transactions = [response.data];
          addressResponse = address;
          // Você precisaria realmente buscar o balance atual se necessário aqui
      } else if (address) {
          const response = await axios.get(`http://localhost:${port}/address/${address}`);
          transactions = response.data.transactions;
          addressResponse = address;
          // Suponha que esses valores sejam obtidos corretamente do backend
          currentBalance = response.data.currentBalance;
          currentPriceBalance = response.data.currentPriceBalance;
      } else {
          transactions = [];
          addressResponse = null;
      }
      res.render('index', {
          transactions,
          address: addressResponse,
          currentBalance,
          currentPriceBalance
      });
  } catch (error) {
      console.error(`Error: ${error}`);
      res.render('index', {
          error: "Failed to fetch data.",
          transactions: [],
          address: null,
          currentBalance: 0,
          currentPriceBalance: 0
      });
  }
});



app.get('/address/:address', async (req: Request, res: Response) => {
  const { address } = req.params;
  const transactionsUrl = `https://mempool.space/api/address/${address}/txs`;
  const balanceUrl = `https://mempool.space/api/address/${address}`;

  try {
      const [transactionsResponse, balanceResponse] = await Promise.all([
          axios.get(transactionsUrl),
          axios.get(balanceUrl)
      ]);

      const priceNow = await fetchLatestPrice();
      const pricePromises = transactionsResponse.data.map((tx: any) => fetchHistoricalPrice(tx.status.block_time));
      const prices = await Promise.all(pricePromises);

      const transactions = transactionsResponse.data.map((tx: any, index: number) => {
          let totalInput = 0;
          let totalOutput = 0;

          tx.vin.forEach((input: any) => {
              if (input.prevout && input.prevout.scriptpubkey_address === address) {
                  totalInput += input.prevout.value;
              }
          });

          tx.vout.forEach((output: any) => {
              if (output.scriptpubkey_address === address) {
                  totalOutput += output.value;
              }
          });

          const netMoved = totalInput - totalOutput;
          const transactionDate = moment.unix(tx.status.block_time).tz("America/Cuiaba").format("DD/MM/YYYY HH:mm");
          const transactionType = netMoved > 0 ? 'sent' : 'received';

          const btcAmount = satoshisToBTC(Math.abs(netMoved));
          const feeBtc = satoshisToBTC(tx.fee);
          const feeUsd = (feeBtc * prices[index]).toFixed(2);
          const transactionAmountUsd = (btcAmount * prices[index]).toFixed(2);
      
          return {
              txid: tx.txid,
              date: transactionDate,
              transactionType,
              transactionAmount: btcAmount.toLocaleString('pt-BR', { minimumFractionDigits: 8 }),
              fee: feeBtc.toLocaleString('pt-BR', { minimumFractionDigits: 8 }),
              btcPriceOnDate: prices[index].toLocaleString('pt-BR', { minimumFractionDigits: 2 }),
              feeInUsd: feeUsd.replace('.', ','),
              transactionAmountInUsd: transactionAmountUsd.replace('.', ',')
          };
      });

      const currentBalance = satoshisToBTC(balanceResponse.data.chain_stats.funded_txo_sum - balanceResponse.data.chain_stats.spent_txo_sum);

      res.json({
          address,
          btcLatestPrice: priceNow,
          currentBalance,
          currentPriceBalance: priceNow * currentBalance,
          transactions
      });

    } catch (error: unknown) {
      // Verifica se o erro é uma instância de Error
      if (error instanceof Error) {
        console.error(`Error processing request: ${error.message}`);
        res.status(500).json({ message: "Erro interno no servidor", details: error.message });
      } else {
        // Caso não seja um erro padrão, loga o tipo para investigação posterior
        console.error(`Error processing request with non-standard error type: ${typeof error}`);
        res.status(500).json({ message: "Erro interno no servidor", details: "Ocorreu um erro desconhecido" });
      }
    }
});

// Rota para buscar detalhes de uma transação específica
app.get('/address/:address/:txid', async (req: Request, res: Response) => {
  const { address, txid } = req.params;
  const transactionUrl = `https://mempool.space/api/tx/${txid}`;

  try {
    const transactionResponse = await axios.get(transactionUrl);

    const transactionData = transactionResponse.data;
    const transactionTimestamp = transactionData.status.block_time;
    const pricePromise = fetchHistoricalPrice(transactionTimestamp);

    const btcPriceOnDate = await pricePromise;

    let totalInput = 0;
    let totalOutput = 0;

    transactionData.vin.forEach((input: any) => {
      if (input.prevout && input.prevout.scriptpubkey_address === address) {
        totalInput += input.prevout.value;
      }
    });

    transactionData.vout.forEach((output: any) => {
      if (output.scriptpubkey_address === address) {
        totalOutput += output.value;
      }
    });

    const netMoved = totalInput - totalOutput;
    const transactionDate = moment.unix(transactionTimestamp).tz("America/Cuiaba").format("DD/MM/YYYY HH:mm");
    const transactionType = netMoved > 0 ? 'sent' : 'received';

    const btcAmount = satoshisToBTC(Math.abs(netMoved));
    const feeBtc = satoshisToBTC(transactionData.fee);
    const feeUsd = (feeBtc * btcPriceOnDate).toFixed(2);
    const transactionAmountUsd = (btcAmount * btcPriceOnDate).toFixed(2);

    const detailedTransaction = {
      txid: txid,
      date: transactionDate,
      transactionType,
      transactionAmount: btcAmount.toLocaleString('pt-BR', { minimumFractionDigits: 8 }),
      transactionAmountInUsd: transactionAmountUsd.replace('.', ','),
      fee: feeBtc.toLocaleString('pt-BR', { minimumFractionDigits: 8 }),
      feeInUsd: feeUsd.replace('.', ','),
      btcPriceOnDate: btcPriceOnDate.toLocaleString('pt-BR', { minimumFractionDigits: 2 })
    };

    res.json(detailedTransaction);

  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`Error processing request: ${error.message}`);
      res.status(500).json({ message: "Erro interno no servidor", details: error.message });
    } else {
      console.error(`Error processing request with non-standard error type: ${typeof error}`);
      res.status(500).json({ message: "Erro interno no servidor", details: "Ocorreu um erro desconhecido" });
    }
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
