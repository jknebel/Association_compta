import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    OrgRole,
    ComptaRole,
    normalizeRoleInput,
    isCaissierRole,
    isVerificateurRole,
    isViewerRole,
    isUploaderRole,
    isValidComptaRole,
    canOpenComptaOnWeb,
    canUploadReceiptToCompta,
    getComptaRoleLabel,
    applyComptaRoleChange
} from '../rbac.ts';

describe('WEB-01 — Unit Tests: Cas Positifs (Nominal)', () => {
    it('définit ComptaRole.UPLOADER avec la valeur exacte "uploader"', () => {
        assert.equal(ComptaRole.UPLOADER, 'uploader');
        assert.equal(ComptaRole.CAISSIER, 'caissier');
        assert.equal(ComptaRole.VERIFICATEUR, 'verificateur');
        assert.equal(ComptaRole.VIEWER, 'viewer');
        assert.equal(ComptaRole.COMPTABLE, 'comptable');
        assert.equal(OrgRole.ADMIN, 'admin');
        assert.equal(OrgRole.CAISSIER, 'caissier');
        assert.equal(OrgRole.MEMBER, 'member');
    });

    it('isUploaderRole reconnaît le rôle uploader', () => {
        assert.equal(isUploaderRole(ComptaRole.UPLOADER), true);
        assert.equal(isUploaderRole('uploader'), true);
    });

    it('isCaissierRole, isVerificateurRole et isViewerRole reconnaissent leurs rôles respectifs', () => {
        assert.equal(isCaissierRole(ComptaRole.CAISSIER), true);
        assert.equal(isCaissierRole(ComptaRole.COMPTABLE), true);
        assert.equal(isCaissierRole('admin'), true);

        assert.equal(isVerificateurRole(ComptaRole.VERIFICATEUR), true);
        assert.equal(isViewerRole(ComptaRole.VIEWER), true);
    });

    it('isValidComptaRole valide tous les rôles de comptabilité légitimes (y compris uploader)', () => {
        assert.equal(isValidComptaRole('caissier'), true);
        assert.equal(isValidComptaRole('comptable'), true);
        assert.equal(isValidComptaRole('verificateur'), true);
        assert.equal(isValidComptaRole('viewer'), true);
        assert.equal(isValidComptaRole('uploader'), true);
    });

    it('canOpenComptaOnWeb autorise caissier, comptable, verificateur, viewer et admin sur le web', () => {
        assert.equal(canOpenComptaOnWeb(ComptaRole.CAISSIER), true);
        assert.equal(canOpenComptaOnWeb(ComptaRole.COMPTABLE), true);
        assert.equal(canOpenComptaOnWeb(ComptaRole.VERIFICATEUR), true);
        assert.equal(canOpenComptaOnWeb(ComptaRole.VIEWER), true);
        assert.equal(canOpenComptaOnWeb('admin'), true);
    });

    it('canUploadReceiptToCompta autorise uploader et caissier/comptable/admin sur une comptabilité active', () => {
        assert.equal(canUploadReceiptToCompta(ComptaRole.UPLOADER, false), true);
        assert.equal(canUploadReceiptToCompta(ComptaRole.CAISSIER, false), true);
        assert.equal(canUploadReceiptToCompta(ComptaRole.COMPTABLE, false), true);
        assert.equal(canUploadReceiptToCompta('admin', false), true);
        assert.equal(canUploadReceiptToCompta('none', false, true, false), true);
        assert.equal(canUploadReceiptToCompta('none', false, false, true), true);
    });

    it('getComptaRoleLabel retourne le libellé français exact pour chaque rôle', () => {
        assert.equal(getComptaRoleLabel('admin'), 'Admin');
        assert.equal(getComptaRoleLabel(ComptaRole.CAISSIER), 'Caissier');
        assert.equal(getComptaRoleLabel(ComptaRole.COMPTABLE), 'Caissier');
        assert.equal(getComptaRoleLabel(ComptaRole.VERIFICATEUR), 'Vérificateur');
        assert.equal(getComptaRoleLabel(ComptaRole.VIEWER), 'Lecteur');
        assert.equal(getComptaRoleLabel(ComptaRole.UPLOADER), 'Déposant Factures');
    });
});

describe('WEB-01 — Unit Tests: Cas Négatifs', () => {
    it('isUploaderRole rejette tous les autres rôles', () => {
        assert.equal(isUploaderRole(ComptaRole.CAISSIER), false);
        assert.equal(isUploaderRole(ComptaRole.COMPTABLE), false);
        assert.equal(isUploaderRole(ComptaRole.VERIFICATEUR), false);
        assert.equal(isUploaderRole(ComptaRole.VIEWER), false);
        assert.equal(isUploaderRole('admin'), false);
        assert.equal(isUploaderRole('none'), false);
        assert.equal(isUploaderRole('upload'), false);
    });

    it('isCaissierRole, isVerificateurRole et isViewerRole rejettent le rôle uploader', () => {
        assert.equal(isCaissierRole(ComptaRole.UPLOADER), false);
        assert.equal(isCaissierRole(ComptaRole.VERIFICATEUR), false);
        assert.equal(isCaissierRole(ComptaRole.VIEWER), false);
        assert.equal(isVerificateurRole(ComptaRole.UPLOADER), false);
        assert.equal(isVerificateurRole(ComptaRole.CAISSIER), false);
        assert.equal(isViewerRole(ComptaRole.UPLOADER), false);
        assert.equal(isViewerRole(ComptaRole.VERIFICATEUR), false);
    });

    it('canOpenComptaOnWeb bloque strictement le rôle uploader sur le web (hors Admin)', () => {
        assert.equal(canOpenComptaOnWeb(ComptaRole.UPLOADER, false, false), false);
        assert.equal(canOpenComptaOnWeb('uploader'), false);
        assert.equal(canOpenComptaOnWeb('none'), false);
        assert.equal(canOpenComptaOnWeb('unknown'), false);
        assert.equal(canOpenComptaOnWeb(''), false);
        assert.equal(canOpenComptaOnWeb(null), false);
        assert.equal(canOpenComptaOnWeb(undefined), false);
    });

    it('canUploadReceiptToCompta refuse les rôles viewer, verificateur et aucun accès', () => {
        assert.equal(canUploadReceiptToCompta(ComptaRole.VIEWER, false, false, false), false);
        assert.equal(canUploadReceiptToCompta(ComptaRole.VERIFICATEUR, false, false, false), false);
        assert.equal(canUploadReceiptToCompta('none', false, false, false), false);
        assert.equal(canUploadReceiptToCompta('', false, false, false), false);
        assert.equal(canUploadReceiptToCompta(null, false, false, false), false);
        assert.equal(canUploadReceiptToCompta(undefined), false);
    });

    it('canUploadReceiptToCompta refuse tout dépôt si la comptabilité est archivée (même pour uploader, caissier ou admin)', () => {
        assert.equal(canUploadReceiptToCompta(ComptaRole.UPLOADER, true, false, false), false);
        assert.equal(canUploadReceiptToCompta(ComptaRole.CAISSIER, true, false, false), false);
        assert.equal(canUploadReceiptToCompta(ComptaRole.UPLOADER, true, true, true), false);
    });

    it('isValidComptaRole rejette les valeurs invalides ou rôles globaux', () => {
        assert.equal(isValidComptaRole('none'), false);
        assert.equal(isValidComptaRole('admin'), false);
        assert.equal(isValidComptaRole('member'), false);
        assert.equal(isValidComptaRole('hacker'), false);
        assert.equal(isValidComptaRole(''), false);
        assert.equal(isValidComptaRole(null), false);
        assert.equal(isValidComptaRole(undefined), false);
    });

    it('applyComptaRoleChange lève une erreur explicite si comptaId est vide ou si le rôle est inconnu', () => {
        assert.throws(
            () => applyComptaRoleChange({}, '', ComptaRole.UPLOADER),
            /Identifiant de comptabilité invalide/
        );
        assert.throws(
            () => applyComptaRoleChange({}, '   ', ComptaRole.UPLOADER),
            /Identifiant de comptabilité invalide/
        );
        assert.throws(
            () => applyComptaRoleChange({}, null, ComptaRole.UPLOADER),
            /Identifiant de comptabilité invalide/
        );
        assert.throws(
            () => applyComptaRoleChange({}, 'compta-1', 'super-hacker'),
            /Rôle de comptabilité invalide: super-hacker/
        );
        assert.throws(
            () => applyComptaRoleChange({}, 'compta-1', 'admin'),
            /Rôle de comptabilité invalide: admin/
        );
    });
});

describe('WEB-01 — Unit Tests: Valeurs Limites & Cas Particuliers (Boundary / Edge Cases)', () => {
    it('normalizeRoleInput gère la casse, les espaces, tabulations et types non-string', () => {
        assert.equal(normalizeRoleInput('  UPLOADER  '), 'uploader');
        assert.equal(normalizeRoleInput('\tUpLoAdEr\n'), 'uploader');
        assert.equal(normalizeRoleInput(''), '');
        assert.equal(normalizeRoleInput('     '), '');
        assert.equal(normalizeRoleInput(null), '');
        assert.equal(normalizeRoleInput(undefined), '');
        assert.equal(normalizeRoleInput(123), '');
        assert.equal(normalizeRoleInput({}), '');
    });

    it('les helpers acceptent des chaînes avec majuscules et espaces autour', () => {
        assert.equal(isUploaderRole('  UPLOADER \n'), true);
        assert.equal(isCaissierRole('  CAISSIER '), true);
        assert.equal(isVerificateurRole(' VERIFICATEUR '), true);
        assert.equal(isViewerRole(' VIEWER '), true);
        assert.equal(getComptaRoleLabel('  UPLOADER  '), 'Déposant Factures');
        assert.equal(getComptaRoleLabel(null), 'Aucun accès');
        assert.equal(getComptaRoleLabel(''), 'Aucun accès');
        assert.equal(getComptaRoleLabel('none'), 'Aucun accès');
        assert.equal(getComptaRoleLabel('inconnu'), 'Aucun accès');
    });

    it('canOpenComptaOnWeb gère les valeurs limites des flags isOrgAdmin et isSuperAdmin', () => {
        assert.equal(canOpenComptaOnWeb(ComptaRole.UPLOADER, true, false), true);
        assert.equal(canOpenComptaOnWeb(ComptaRole.UPLOADER, false, true), true);
        assert.equal(canOpenComptaOnWeb(ComptaRole.UPLOADER, 'yes', false), false);
        assert.equal(canOpenComptaOnWeb(ComptaRole.UPLOADER, false, 1), false);
    });

    it('canUploadReceiptToCompta vérifie strictement les booléens isArchived, isOrgAdmin, isSuperAdmin', () => {
        assert.equal(canUploadReceiptToCompta(ComptaRole.UPLOADER, 'true', false, false), true);
        assert.equal(canUploadReceiptToCompta('none', false, 'true', false), false);
        assert.equal(canUploadReceiptToCompta('none', false, false, 'true'), false);
    });

    it("applyComptaRoleChange préserve l'immutabilité, nettoie les espaces de comptaId et gère la suppression ('none', '', null, undefined)", () => {
        const original = { 'compta-a': ComptaRole.VIEWER };
        const updated = applyComptaRoleChange(original, '  compta-b  ', '  UPLOADER ');

        assert.deepEqual(original, { 'compta-a': ComptaRole.VIEWER });
        assert.deepEqual(updated, {
            'compta-a': ComptaRole.VIEWER,
            'compta-b': ComptaRole.UPLOADER
        });

        const removedNone = applyComptaRoleChange(updated, 'compta-b', 'none');
        assert.deepEqual(removedNone, { 'compta-a': ComptaRole.VIEWER });
        assert.equal('compta-b' in removedNone, false);

        const removedEmpty = applyComptaRoleChange(updated, 'compta-b', '   ');
        assert.equal('compta-b' in removedEmpty, false);

        const removedNull = applyComptaRoleChange(updated, 'compta-b', null);
        assert.equal('compta-b' in removedNull, false);

        const removedUndefined = applyComptaRoleChange(updated, 'compta-b', undefined);
        assert.equal('compta-b' in removedUndefined, false);

        const fromNull = applyComptaRoleChange(null, 'compta-x', ComptaRole.UPLOADER);
        assert.deepEqual(fromNull, { 'compta-x': ComptaRole.UPLOADER });
    });
});

describe('WEB-01 — Integration Tests: Flux Complet Membre & Composants Web', () => {
    it('Scénario 1 : Membre multi-comptabilités (Déposant sur Pionnier 26-27 + Lecteur sur Groupe 25-26)', () => {
        let memberAccess = {};

        memberAccess = applyComptaRoleChange(memberAccess, 'pionnier-26-27', ComptaRole.UPLOADER);
        memberAccess = applyComptaRoleChange(memberAccess, 'groupe-25-26', ComptaRole.VIEWER);

        assert.equal(memberAccess['pionnier-26-27'], ComptaRole.UPLOADER);
        assert.equal(memberAccess['groupe-25-26'], ComptaRole.VIEWER);

        assert.equal(canUploadReceiptToCompta(memberAccess['pionnier-26-27'], false, false, false), true);
        assert.equal(canOpenComptaOnWeb(memberAccess['pionnier-26-27'], false, false), false);
        assert.equal(getComptaRoleLabel(memberAccess['pionnier-26-27']), 'Déposant Factures');

        assert.equal(canOpenComptaOnWeb(memberAccess['groupe-25-26'], false, false), true);
        assert.equal(canUploadReceiptToCompta(memberAccess['groupe-25-26'], false, false, false), false);
        assert.equal(getComptaRoleLabel(memberAccess['groupe-25-26']), 'Lecteur');
    });

    it('Scénario 2 : Cycle de vie complet des permissions (Attribution -> Promotion -> Rétrogradation -> Révocation)', () => {
        let access = undefined;

        access = applyComptaRoleChange(access, 'louveteaux-26-27', ComptaRole.UPLOADER);
        assert.equal(canOpenComptaOnWeb(access['louveteaux-26-27']), false);
        assert.equal(canUploadReceiptToCompta(access['louveteaux-26-27']), true);

        access = applyComptaRoleChange(access, 'louveteaux-26-27', ComptaRole.CAISSIER);
        assert.equal(canOpenComptaOnWeb(access['louveteaux-26-27']), true);
        assert.equal(canUploadReceiptToCompta(access['louveteaux-26-27']), true);

        access = applyComptaRoleChange(access, 'louveteaux-26-27', ComptaRole.UPLOADER);
        assert.equal(canOpenComptaOnWeb(access['louveteaux-26-27']), false);
        assert.equal(canUploadReceiptToCompta(access['louveteaux-26-27']), true);

        access = applyComptaRoleChange(access, 'louveteaux-26-27', 'none');
        assert.equal(canOpenComptaOnWeb(access['louveteaux-26-27']), false);
        assert.equal(canUploadReceiptToCompta(access['louveteaux-26-27']), false);
    });

    it("Scénario 3 : Vérification de l'intégration dans AdminView.tsx et OrgSelector.tsx", () => {
        const componentsDir = path.resolve(import.meta.dirname, '../../components');
        const adminViewCode = fs.readFileSync(path.join(componentsDir, 'AdminView.tsx'), 'utf8');
        const orgSelectorCode = fs.readFileSync(path.join(componentsDir, 'OrgSelector.tsx'), 'utf8');

        assert.equal(adminViewCode.includes('ComptaRole.UPLOADER'), true);
        assert.equal(adminViewCode.includes('<option value="uploader">📸 Déposant Factures</option>'), true);
        assert.equal(adminViewCode.includes('isUploaderRole'), true);
        assert.equal(adminViewCode.includes('getComptaRoleLabel'), true);

        assert.equal(orgSelectorCode.includes('canOpenComptaOnWeb'), true);
        assert.equal(orgSelectorCode.includes('isUploaderRole'), true);
        assert.equal(orgSelectorCode.includes('App Mobile uniquement'), true);
    });
});
