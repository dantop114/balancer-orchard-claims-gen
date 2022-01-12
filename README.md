# balancer-orchard-claims-gen

This utility can be used to generate calldata needed to claim from Balancer's merkle orchard ([0xdAE7e32ADc5d490a43cCba1f0c736033F2b4eFca](https://etherscan.io/address/0xdAE7e32ADc5d490a43cCba1f0c736033F2b4eFca)).

## How to use

- Edit `src/lib/config/config.json` with your infura keys.

- Run the script:
    ```
    yarn
    ts-node src/index.ts -c <chain> -a <account> -o <report-file-output>
    ```


This utility does not post the claim transaction on-chain. 
You can use the generated calldata with your transaction posting infra.