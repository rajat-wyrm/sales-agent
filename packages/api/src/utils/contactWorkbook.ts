import {
  CONTACT_EXPORT_COLUMNS,
  CONTACT_EXPORT_GROUPS,
  contactsToCsv,
  guardFormula,
} from '../utils/contactColumns';

const xmlEscape = (v: unknown): string => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const isUrl = (v: unknown) => /^https?:\/\//i.test(String(v ?? '').trim());

/**
 * SpreadsheetML 2003 workbook for a set of contact rows: grouped frozen header,
 * autofilter, banded rows, clickable URLs and a Summary sheet.
 * Excel/LibreOffice open it natively — no xlsx dependency for one template string.
 */
export function buildContactsWorkbook(rows: any[], requestedBy: string, truncated = false): string {
  const cols = CONTACT_EXPORT_COLUMNS;
  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const nCols = cols.length;

  const groupRow = `<Row ss:Height="18">${CONTACT_EXPORT_GROUPS.map((g) => {
    const span = cols.filter((c) => c.group === g).length;
    return `<Cell ss:MergeAcross="${span - 1}" ss:StyleID="sGroup"><Data ss:Type="String">${xmlEscape(g)}</Data></Cell>`;
  }).join('')}</Row>`;

  const headerRow = `<Row ss:Height="24">${cols.map((c) =>
    `<Cell ss:StyleID="sHead"><Data ss:Type="String">${xmlEscape(c.header)}</Data></Cell>`).join('')}</Row>`;

  const body = rows.map((r, i) => {
    const stripe = i % 2 === 1;
    const cells = cols.map((c) => {
      const base = stripe ? 'sBodyAlt' : 'sBody';
      const v = c.get(r);
      if (v === null || v === undefined || v === '') return `<Cell ss:StyleID="${base}"/>`;
      const safe = guardFormula(v);
      const inner = `<Data ss:Type="String">${xmlEscape(safe)}</Data>`;
      if (isUrl(safe)) {
        return `<Cell ss:StyleID="sLink" ss:HRef="${xmlEscape(safe)}"><Data ss:Type="String">${xmlEscape(safe)}</Data></Cell>`;
      }
      return `<Cell ss:StyleID="${base}">${inner}</Cell>`;
    }).join('');
    return `<Row>${cells}</Row>`;
  }).join('');

  const widths = cols.map((c) => `<Column ss:AutoFitWidth="0" ss:Width="${c.width}"/>`).join('');
  const totalCols = nCols;
  const filterRange = `R2C1:R${rows.length + 2}C${totalCols}`;

  // ---- Summary sheet ----
  const tally = (label: string, count: number) =>
    `<Row><Cell ss:StyleID="sBody"><Data ss:Type="String">${xmlEscape(label)}</Data></Cell><Cell ss:StyleID="sNum"><Data ss:Type="Number">${count}</Data></Cell></Row>`;
  const section = (title: string) =>
    `<Row><Cell ss:StyleID="sSection"><Data ss:Type="String">${xmlEscape(title)}</Data></Cell></Row>`;
  const groupBy = (key: string) => {
    const map = new Map<string, number>();
    for (const r of rows) {
      const k = String((r as any)[key] ?? '(blank)') || '(blank)';
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  };

  const contactable = rows.filter((r) => r.personal_email || r.personal_mobile || r.linkedin_url).length;
  const summary = [
    tally('Total contacts', rows.length),
    tally('Contactable (email, mobile or LinkedIn)', contactable),
    tally('With personal email', rows.filter((r) => r.personal_email).length),
    tally('With personal mobile', rows.filter((r) => r.personal_mobile).length),
    tally('With LinkedIn', rows.filter((r) => r.linkedin_url).length),
    tally('With company', rows.filter((r) => r.company_name).length),
    tally('High confidence (≥80)', rows.filter((r) => (r.confidence_score ?? 0) >= 80).length),
    ...(truncated ? [`<Row><Cell ss:StyleID="sWarn"><Data ss:Type="String">TRUNCATED — more matching contacts exist than the export cap; narrow the search and export again.</Data></Cell></Row>`] : []),
  ].join('');

  const confidenceBands = groupBy('confidence_score').map(([k, v]) => tally(`Score ${k}`, v)).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
   <Title>HireGen HR Contacts Export</Title>
   <Author>HireGen Sales Agent</Author>
   <Created>${nowIso}</Created>
   <Description>${rows.length} contacts, ${nCols} columns${requestedBy ? `, exported by ${xmlEscape(requestedBy)}` : ''}</Description>
 </DocumentProperties>
 <Options>
   <ActiveTab>1</ActiveTab>
 </Options>
 <Styles>
   <Style ss:ID="Default" ss:Name="Normal"><Font ss:FontName="Calibri" ss:Size="11"/><Alignment ss:Vertical="Center"/></Style>
   <Style ss:ID="sGroup"><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#FFFFFF" ss:Bold="1"/>
    <Interior ss:Color="#12233A" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
    <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#1F3A5F"/></Borders></Style>
   <Style ss:ID="sHead"><Font ss:FontName="Calibri" ss:Size="11" ss:Color="#FFFFFF" ss:Bold="1"/>
    <Interior ss:Color="#1F3A5F" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
    <Borders>
     <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#12233A"/>
     <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#3C5A80"/>
    </Borders></Style>
   <Style ss:ID="sBody"><Font ss:FontName="Calibri" ss:Size="10"/><Alignment ss:Vertical="Top" ss:WrapText="0"/>
    <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E3E7EE"/></Borders></Style>
   <Style ss:ID="sBodyAlt"><Font ss:FontName="Calibri" ss:Size="10"/><Alignment ss:Vertical="Top"/>
    <Interior ss:Color="#F6F8FB" ss:Pattern="Solid"/>
    <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E3E7EE"/></Borders></Style>
   <Style ss:ID="sNum"><Font ss:FontName="Calibri" ss:Size="10"/><Alignment ss:Horizontal="Right" ss:Vertical="Top"/>
    <NumberFormat ss:Format="#,##0"/>
    <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E3E7EE"/></Borders></Style>
   <Style ss:ID="sDate"><Font ss:FontName="Calibri" ss:Size="10"/><Alignment ss:Horizontal="Left" ss:Vertical="Top"/>
    <NumberFormat ss:Format="yyyy-mm-dd hh:mm"/>
    <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E3E7EE"/></Borders></Style>
   <Style ss:ID="sLink"><Font ss:FontName="Calibri" ss:Size="10" ss:Color="#0F62FE" ss:Underline="Single"/>
    <Alignment ss:Vertical="Top"/>
    <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E3E7EE"/></Borders></Style>
   <Style ss:ID="sSumHead"><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#1F3A5F"/></Style>
   <Style ss:ID="sWarn"><Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#8B1E1E"/><Interior ss:Color="#FBE3E3" ss:Pattern="Solid"/></Style>
   <Style ss:ID="sSection"><Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/>
    <Interior ss:Color="#1F3A5F" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left"/></Style>
  </Styles>
  <Worksheet ss:Name="Summary">
   <Table ss:DefaultRowHeight="18">
    <Column ss:AutoFitWidth="0" ss:Width="240"/><Column ss:AutoFitWidth="0" ss:Width="110"/>
    <Row ss:Height="26"><Cell ss:StyleID="sSumHead"><Data ss:Type="String">HireGen HR Contacts Export</Data></Cell></Row>
    ${section('Overview')}
    ${summary}
    <Row><Cell ss:StyleID="sBody"><Data ss:Type="String">Exported at</Data></Cell><Cell ss:StyleID="sBody"><Data ss:Type="String">${nowIso}</Data></Cell></Row>
    <Row><Cell ss:StyleID="sBody"><Data ss:Type="String">Requested by</Data></Cell><Cell ss:StyleID="sBody"><Data ss:Type="String">${xmlEscape(requestedBy || '-')}</Data></Cell></Row>
    ${section('By confidence band')}${confidenceBands}
   </Table>
   <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
    <DisplayGridlines/>
   </WorksheetOptions>
  </Worksheet>
  <Worksheet ss:Name="Contacts">
   <Table ss:DefaultRowHeight="16">${widths}${groupRow}${headerRow}${body}</Table>
   <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
    <FreezePanes/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane>
    <Pane><xSplit>0</xSplit><ySplit>1</ySplit><TopRow>1</TopRow><LeftColumn>0</LeftColumn>
     <ActiveRow>2</ActiveRow><ActiveCol>0</ActiveCol></Pane>
    <PageSetup><x:Layout x:Orientation="Landscape"/><x:PageMargins x:Bottom="0.5" x:Left="0.4" x:Right="0.4" x:Top="0.5"/></PageSetup>
    <Print><ValidPrinterInfo/><PaperSizeIndex>9</PaperSizeIndex><HorizontalResolution>600</HorizontalResolution></Print>
    <Selected/>
   </WorksheetOptions>
   <AutoFilter x:Range="${filterRange}" xmlns="urn:schemas-microsoft-com:office:excel"/>
  </Worksheet>
 </Workbook>`;
}

/** Plain-text CSV built from the same registry, for a "filtered CSV" download. */
export function buildContactsCsv(rows: any[]): string {
  return contactsToCsv(rows);
}
