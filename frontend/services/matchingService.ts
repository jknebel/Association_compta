import { Transaction, Receipt } from '../../types';

export const matchTransactionsWithReceipts = (
    transactions: Transaction[],
    receipts: Receipt[]
): { processedTxns: Transaction[], matchedReceiptIds: string[] } => {
    const matchedIds: string[] = [];
    const unlinkedReceipts = receipts.filter(r => !r.linkedTransactionId);
    const processedTxns = [...transactions]; // Clone

    // We only want to process transactions that DON'T have a receipt yet
    // OR we process all? The prompt said "relaunch for those not having an account or receipt"
    // But here we are iterating ALL transactions passed to us. 

    const updatedTxns = processedTxns.map(txn => {
        // If already has receipt, skip
        if (txn.receiptUrl) return txn;

        // Find best match in unlinked receipts
        const match = unlinkedReceipts.find(r => {
            if (matchedIds.includes(r.id)) return false; // Already taken by another txn in this batch

            let isMatch = false;
            // Check Amount matches (tolerance 0.1)
            if (r.extractedAmount && Math.abs(Math.abs(txn.amount) - r.extractedAmount) < 0.1) {
                // Check Date matches (tolerance 7 days)
                if (r.extractedDate) {
                    const d1 = new Date(r.extractedDate).getTime();
                    const d2 = new Date(txn.date).getTime();
                    const diff = Math.abs(d1 - d2) / (1000 * 3600 * 24);
                    if (diff <= 7) isMatch = true;
                }
            }
            return isMatch;
        });

        if (match) {
            matchedIds.push(match.id);
            const nameWithoutExt = match.fileName ? match.fileName.replace(/\.[^/.]+$/, "") : undefined;
            return { ...txn, receiptUrl: match.url, receiptFileName: nameWithoutExt };
        }
        return txn;
    });

    return { processedTxns: updatedTxns, matchedReceiptIds: matchedIds };
};
