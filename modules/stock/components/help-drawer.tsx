'use client'

import { Drawer } from '@/modules/stock/components/drawer'

export function HelpDrawer({ onClose }: { onClose: () => void }) {
  return <Drawer title="How Fleetwise files" eyebrow="HELP" onClose={onClose}>
    <div className="help-body">
      <p>Drop files into the logbooks, certificates, photos, or agreements Drive folders, including files inside nested folders. Keep Fleetwise open and it scans those folders on its own — including JPEG, PNG, and PDF documents — then renames photos, insurance, and logbooks as Photos KMHE520A, Insurance - KMHE520A, or KMHE520A - Logbook. Already-renamed files are only written to the sheet if that cell is still empty. Insurance PDFs use REGISTRATION No; logbook PDFs use the REGISTRATION field on the document. Set an insurance inbox and a logbook inbox in Settings; Check inboxes downloads attachments from those addresses into the matching folders.</p>
      <p>Agreements Only reads each PDF under the Loan Agreements folder, including files in subfolders. It takes the registration from Registration No. inside the document. When a plate has more than one PDF, the latest signed copy is chipped onto an empty Agreement Link cell. Unsigned files and cells that already have a chip are left alone, and the PDF name is not changed. Photos whose name includes Branded go to Asset Photo(Branded). Every scan re-reads Collateral Files: empty cells get a folder named after the registration number under the collateral parent, then a Drive chip. Cells that already have a Drive chip are left as they are.</p>
      <p>Plates that cannot be read, or that are not on the matching sheet, stay in Unmatched. Sign out and in again after this update so Sheets access is granted. Enable the Google Sheets API on the Cloud project.</p>
    </div>
  </Drawer>
}
