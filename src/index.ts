import { program } from "commander";
import axios from "axios";
import merkleOrchardAbi from "./lib/abi/MerkleOrchard.json"
import { chain, chunk, flatten } from "lodash";
import { loadTree } from "./lib/utils/merkle";
import { soliditySha3 } from "web3-utils";
import { bnum, scale } from "./lib/utils";
import { getAddress } from "@ethersproject/address";
import { JsonRpcProvider, TransactionResponse, Web3Provider } from "@ethersproject/providers"
import { MultiTokenPendingClaims, TokenClaimInfo, Report, Snapshot, ClaimStatus, ClaimProofTuple, ComputeClaimProofPayload, ClaimsArguments } from "./types";
import { multicall } from "./lib/balancer/contract";
import { ethers } from "ethers";
import * as fs from 'fs';

import config from "./lib/config"

import TokenDecimals from './TokenDecimals.json';
import MultiTokenClaim from './MultiTokenClaim.json';

program
    .requiredOption("-a --account <account>", "Account")
    .requiredOption("-c, --chainid <chain-id>", "Chain ID")
    .requiredOption("-o, --output <output>", "Output File")
    .parse(process.argv);

const options = program.opts();

const account: string = getAddress(options.account);
const chainid: string = options.chainid;
const outputFile: string = options.output;
const jsonProvider: JsonRpcProvider = new JsonRpcProvider(config.networks[chainid].rpc)

async function ipfsGet<T>(hash: string): Promise<T> {
    const { data } = await axios.get(
        `https://ipfs.infura.io:5001/api/v0/cat?arg=${hash}`
    );

    return data;
}

async function getMultiTokensPendingClaims(
    account: string
): Promise<MultiTokenPendingClaims[]> {
    const tokenClaimsInfo = getTokenClaimsInfo();
    if (tokenClaimsInfo != null) {
        const multiTokenPendingClaims = await Promise.all(
            tokenClaimsInfo.map(tokenClaimInfo =>
                getTokenPendingClaims(tokenClaimInfo, account)
            )
        );

        const multiTokenPendingClaimsWithRewards = multiTokenPendingClaims.filter(
            pendingClaim => Number(pendingClaim.availableToClaim) > 0
        );

        return multiTokenPendingClaimsWithRewards;
    }
    return [];
}

async function getTokenPendingClaims(
    tokenClaimInfo: TokenClaimInfo,
    account: string
): Promise<MultiTokenPendingClaims> {
    const snapshot = await getSnapshot(tokenClaimInfo.manifest);
    const weekStart = tokenClaimInfo.weekStart;
    const claimStatus = await getClaimStatus(
        Object.keys(snapshot).length,
        account,
        tokenClaimInfo
    );

    const pendingWeeks = claimStatus
        .map((status, i) => [i + weekStart, status])
        .filter(([, status]) => !status)
        .map(([i]) => i) as number[];

    const reports = await getReports(snapshot, pendingWeeks);

    const claims = Object.entries(reports)
        .filter((report: Report) => report[1][account])
        .map((report: Report) => {
            return {
                id: report[0],
                amount: report[1][account]
            };
        });

    const availableToClaim = claims
        .map(claim => parseFloat(claim.amount))
        .reduce((total, amount) => total.plus(amount), bnum(0))
        .toString();

    return {
        claims,
        reports,
        tokenClaimInfo,
        availableToClaim
    };
}

async function getClaimStatus(
    totalWeeks: number,
    account: string,
    tokenClaimInfo: TokenClaimInfo
): Promise<ClaimStatus[]> {
    const { token, distributor, weekStart } = tokenClaimInfo;

    const claimStatusCalls = Array.from({ length: totalWeeks }).map((_, i) => [
        config.networks[chainid].addresses.merkleOrchard,
        'isClaimed',
        [token, distributor, weekStart + i, account]
    ]);

    const rootCalls = Array.from({ length: totalWeeks }).map((_, i) => [
        config.networks[chainid].addresses.merkleOrchard,
        'getDistributionRoot',
        [token, distributor, weekStart + i]
    ]);

    try {
        const result = (await multicall<boolean | string>(
            chainid,
            jsonProvider,
            merkleOrchardAbi,
            [...claimStatusCalls, ...rootCalls],
            {},
            true
        )) as (boolean | string)[];

        if (result.length > 0) {
            const chunks = chunk(flatten(result), totalWeeks);

            const claimedResult = chunks[0] as boolean[];
            const distributionRootResult = chunks[1] as string[];

            return claimedResult.filter(
                (_, index) =>
                    distributionRootResult[index] !== ethers.constants.HashZero
            );
        }
    } catch (e) {
        console.log('[Claim] Claim Status Error:', e);
    }

    return [];
}

async function getReports(snapshot: Snapshot, weeks: number[]) {
    const reports = await Promise.all<Report>(
        weeks
            .filter(week => snapshot[week] != null)
            .map(week => ipfsGet(snapshot[week]))
    );
    return Object.fromEntries(reports.map((report, i) => [weeks[i], report]));
}

async function getSnapshot(manifest: string) {
    try {
        const response = await axios.get<Snapshot>(manifest);
        return response.data || {};
    } catch (error) {
        return {};
    }
}

function getTokenClaimsInfo() {
    const tokenClaims = (MultiTokenClaim as any)[chainid];
    const tokenDecimals = (TokenDecimals as any)[chainid];

    if (tokenClaims != null) {
        return (tokenClaims as TokenClaimInfo[]).map(tokenClaim => ({
            ...tokenClaim,
            token: getAddress(tokenClaim.token),
            decimals:
                tokenDecimals != null && tokenDecimals[tokenClaim.token]
                    ? tokenDecimals[tokenClaim.token]
                    : 18
        }));
    }

    return null;
}

function multiTokenClaimRewards(
    account: string,
    multiTokenPendingClaims: MultiTokenPendingClaims[]
) : ClaimsArguments {
    const tokens = multiTokenPendingClaims.map(
        tokenPendingClaims => tokenPendingClaims.tokenClaimInfo.token
    );

    const multiTokenClaims = multiTokenPendingClaims.map((tokenPendingClaims, tokenIndex) =>
        computeClaimProofs(tokenPendingClaims, account, tokenIndex)
    );
    
    return {
        account,
        claims: flatten(multiTokenClaims),
        tokens
    }
}

function computeClaimProofs(
    tokenPendingClaims: MultiTokenPendingClaims,
    account: string,
    tokenIndex: number
): ClaimProofTuple[] {
    return tokenPendingClaims.claims.map(claim => {
        const payload: ComputeClaimProofPayload = {
            account,
            distributor: tokenPendingClaims.tokenClaimInfo.distributor,
            tokenIndex,
            decimals: tokenPendingClaims.tokenClaimInfo.decimals,
            // objects must be cloned
            report: { ...tokenPendingClaims.reports[claim.id] },
            claim: { ...claim }
        };

        return computeClaimProof(payload);
    });
}

function computeClaimProof(
    payload: ComputeClaimProofPayload
): ClaimProofTuple {
    const {
        report,
        account,
        claim,
        distributor,
        tokenIndex,
        decimals
    } = payload;

    const claimAmount = claim.amount;
    const merkleTree = loadTree(report, decimals);

    const scaledBalance = scale(claimAmount, decimals).toString(10);

    const proof = merkleTree.getHexProof(
        soliditySha3(
            { t: 'address', v: account },
            { t: 'uint', v: scaledBalance }
        )
    ) as string[];

    return [parseInt(claim.id), scaledBalance, distributor, tokenIndex, proof];

}


async function main() {
    console.log("Claims creation now running 🧞‍♂️");

    console.log("Fetching reports and claimable amounts 🔌");
    const pendingClaims = await getMultiTokensPendingClaims(account);

    if (pendingClaims.length === 0) {
        console.log("No pending claims! Aborting... ⛔");
        return;
    }

    console.log("Writing findings to output file 💿");
    fs.writeFileSync(outputFile, JSON.stringify(pendingClaims));
    console.log("File written to ", outputFile, " 💿");

    console.log("Generating call arguments for claims 🧮");
    const claims = multiTokenClaimRewards(account, pendingClaims);

    const iface = new ethers.utils.Interface(merkleOrchardAbi);
    const calldata = iface.encodeFunctionData("claimDistributions", [claims.account, claims.claims, claims.tokens]);

    console.log("Merkle Orchard address: ", config.networks[chainid].addresses.merkleOrchard);
    console.log("Method to call: claimDistributions(address,Claim[],address[])");
    console.log("Calldata: ", calldata);
    console.log("Arguments: ", claims);

}


main().catch((e) => {
    console.log(e);
    process.exit(1);
})