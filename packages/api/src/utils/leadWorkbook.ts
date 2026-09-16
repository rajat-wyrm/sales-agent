import {
  LEAD_SELECT_SQL,
  LEAD_EXPORT_COLUMNS,
  EXPORT_GROUPS,
  leadsToCsv,
  guardFormula,
} from '../utils/leadColumns';

/**
 * The FROM block shared by GET /leads and GET /leads/export: every table a column in
 * LEAD_SELECT_SQL needs. Keeping it here stops the two queries drifting apart.
 */
export const LEAD_FROM_SQL = `
      FROM leads l
      JOIN companies c ON l.company_id = c.id
      JOIN job_postings jp ON l.job_posting_id = jp.id
      LEFT JOIN hr_contacts hc ON l.hr_contact_id = hc.id
      LEFT JOIN users au ON au.id = l.assigned_to`;

const xmlEscape = (v: unknown): string => String(v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // Strip control chars that produce a corrupt-but-openable workbook.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const isUrl = (v: unknown) => /^https?:\/\//i.test(String(v ?? '').trim());

/**
 * SpreadsheetML 2003 workbook for a set of lead rows: grouped frozen header, autofilter,
 * banded rows, score-band fill, clickable URLs and a Summary sheet. Excel/LibreOffice open
 * it natively, so no xlsx dependency for what is one template string.
 */
export function buildLeadsWorkbook(rows: any[], requestedBy: string, truncated = false): string {
  const cols = LEAD_EXPORT_COLUMNS;
  const nowIso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const nCols = cols.length;

  const cell = (c: (typeof cols)[number], r: any, band: string | null, stripe: boolean) => {
    const style =
      c.type === 'Number' ? 'sNum' :
      c.type === 'DateTime' ? 'sDate' :
      stripe ? 'sBodyAlt' : 'sBody';
    const bandStyle = c.field === 'score_band' || c.field === 'lead_score'
      ? (band === 'hot' ? 'sHot' : band === 'warm' ? 'sWarm' : 'sCold')
      : null;
    const sid = bandStyle ?? style;
    const v = c.get(r);

    if (v === null || v === undefined || v === '') return `<Cell ss:StyleID="${sid}"/>`;

    if (c.type === 'Number' && Number.isFinite(Number(v))) {
      return `<Cell ss:StyleID="${sid}"><Data ss:Type="Number">${Number(v)}</Data></Cell>`;
    }
    if (c.type === 'DateTime') {
      const d = new Date(String(v));
      if (!Number.isNaN(d.getTime())) {
        return `<Cell ss:StyleID="${sid}"><Data ss:Type="DateTime">${d.toISOString().replace(/\.\d+Z$/, 'Z')}</Data></Cell>`;
      }
    }
    // Guard against formula execution; see guardFormula for why '-' and '|' count too.
    const safe = guardFormula(v);
    const inner = `<Data ss:Type="String">${xmlEscape(safe)}</Data>`;
    if (c.type === 'Url' && isUrl(safe)) {
      // ss:HRef makes the cell clickable in both Excel and LibreOffice's SpreadsheetML
      // reader (a HYPERLINK() *formula* is dropped on import there), while the visible
      // text stays the plain URL so it can still be copied out of the cell.
      return `<Cell ss:StyleID="sLink" ss:HRef="${xmlEscape(safe)}"><Data ss:Type="String">${xmlEscape(safe)}</Data></Cell>`;
    }
    return `<Cell ss:StyleID="${sid}">${inner}</Cell>`;
  };

  // Row 1 = group banner, row 2 = column headers. Both stay visible.
  // Two frozen columns (# and Company) on the left, so scrolling right across 50
  // columns never loses track of whose row you are reading.
  const groupRow = `<Row ss:Height="18"><Cell ss:StyleID="sGroup"/><Cell ss:StyleID="sGroup"/>${EXPORT_GROUPS.map((g) => {
    const span = cols.filter((c) => c.group === g).length;
    return `<Cell ss:MergeAcross="${span - 1}" ss:StyleID="sGroup"><Data ss:Type="String">${xmlEscape(g)}</Data></Cell>`;
  }).join('')}</Row>`;

  const headerRow = `<Row ss:Height="24"><Cell ss:StyleID="sHead"><Data ss:Type="String">#</Data></Cell><Cell ss:StyleID="sHead"><Data ss:Type="String">Company (row key)</Data></Cell>${cols.map((c) =>
    `<Cell ss:StyleID="sHead"><Data ss:Type="String">${xmlEscape(c.header)}</Data></Cell>`).join('')}</Row>`;

  const renderRow = (r: any, i: number) => {
    const band = r.score_band ?? null;
    const stripe = i % 2 === 1;
    return `<Row><Cell ss:StyleID="${stripe ? 'sNumAlt' : 'sIdx'}"><Data ss:Type="Number">${i + 1}</Data></Cell><Cell ss:StyleID="${stripe ? 'sBodyAlt' : 'sBody'}"><Data ss:Type="String">${xmlEscape(r.company_name ?? '')}</Data></Cell>${cols.map((c) => cell(c, r, band, stripe)).join('')}</Row>`;
  };
  const body = rows.map(renderRow).join('');

  // Two frozen columns on the left (# and Company) plus one per data column.
  const widths = '<Column ss:AutoFitWidth="0" ss:Width="7"/><Column ss:AutoFitWidth="0" ss:Width="26"/>'
    + cols.map((c) => `<Column ss:AutoFitWidth="0" ss:Width="${c.width}"/>`).join('');
  const totalCols = nCols + 2;
  const filterRange = `R2C1:R${rows.length + 2}C${totalCols}`;

  // ---- Summary sheet: counts a rep actually wants before opening the big tab ----
  const tally = (label: string, count: number) =>
    `<Row><Cell ss:StyleID="sBody"><Data ss:Type="String">${xmlEscape(label)}</Data></Cell><Cell ss:StyleID="sNum"><Data ss:Type="Number">${count}</Data></Cell></Row>`;
  const section = (title: string) =>
    `<Row><Cell ss:StyleID="sSection"><Data ss:Type="String">${xmlEscape(title)}</Data></Cell></Row>`;
  const groupBy = (key: string) => {
    const map = new Map<string, number>();
    for (const r of rows) {
      const k = String(r[key] ?? '(blank)') || '(blank)';
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  };

  const contactable = rows.filter((r) => r.hr_email || r.hr_mobile || r.hr_linkedin_url).length;
  const summary = [
    tally('Contactable (email, mobile or LinkedIn)', contactable),
    tally('With HR email', rows.filter((r) => r.hr_email).length),
    tally('With HR mobile', rows.filter((r) => r.hr_mobile).length),
    tally('With HR LinkedIn', rows.filter((r) => r.hr_linkedin_url).length),
    tally('Email verified', rows.filter((r) => r.email_status === 'valid').length),
    tally('With salary', rows.filter((r) => r.salary_range || r.salary_min != null).length),
    tally('With job description', rows.filter((r) => r.job_description).length),
    tally('Distinct companies', new Set(rows.map((r) => r.company_name).filter(Boolean)).size),
    ...(truncated ? [`<Row><Cell ss:StyleID="sWarn"><Data ss:Type="String">TRUNCATED — more matching leads exist than the export cap; narrow the filters and export again.</Data></Cell></Row>`] : []),
  ].join('');

  const bandRows = groupBy('score_band').map(([k, v]) => tally(k, v)).join('');
  const stageRows = groupBy('pipeline_stage').map(([k, v]) => tally(k, v)).join('');
  const sourceRows = groupBy('source_site').map(([k, v]) => tally(k, v)).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
  <Title>HireGen Leads Export</Title>
  <Author>HireGen Sales Agent</Author>
  <Created>${nowIso}</Created>
  <Description>${rows.length} leads, ${nCols} columns${requestedBy ? `, exported by ${xmlEscape(requestedBy)}` : ''}</Description>
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
  <Style ss:ID="sIdx"><Font ss:FontName="Calibri" ss:Size="9" ss:Color="#8A93A3"/><Alignment ss:Horizontal="Right" ss:Vertical="Top"/></Style>
  <Style ss:ID="sNumAlt"><Font ss:FontName="Calibri" ss:Size="9" ss:Color="#8A93A3"/><Alignment ss:Horizontal="Right" ss:Vertical="Top"/><Interior ss:Color="#F6F8FB" ss:Pattern="Solid"/></Style>
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
  <Style ss:ID="sHot"><Font ss:FontName="Calibri" ss:Size="10" ss:Bold="1" ss:Color="#8B1E1E"/><Interior ss:Color="#FBE3E3" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Top"/></Style>
  <Style ss:ID="sWarm"><Font ss:FontName="Calibri" ss:Size="10" ss:Color="#8A5A00"/><Interior ss:Color="#FDF1DC" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Top"/></Style>
  <Style ss:ID="sCold"><Font ss:FontName="Calibri" ss:Size="10" ss:Color="#3B4351"/><Interior ss:Color="#EDF0F5" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Top"/></Style>
  <Style ss:ID="sSumHead"><Font ss:FontName="Calibri" ss:Size="14" ss:Bold="1" ss:Color="#1F3A5F"/></Style>
  <Style ss:ID="sWarn"><Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#8B1E1E"/><Interior ss:Color="#FBE3E3" ss:Pattern="Solid"/></Style>
  <Style ss:ID="sSection"><Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1F3A5F" ss:Pattern="Solid"/><Alignment ss:Horizontal="Left"/></Style>
 </Styles>
 <Worksheet ss:Name="Summary">
  <Table ss:DefaultRowHeight="18">
   <Column ss:AutoFitWidth="0" ss:Width="240"/><Column ss:AutoFitWidth="0" ss:Width="110"/>
   <Row ss:Height="26"><Cell ss:StyleID="sSumHead"><Data ss:Type="String">HireGen Leads Export</Data></Cell></Row>
   ${section('Overview')}
   ${tally('Total leads', rows.length)}
   ${tally('Columns', nCols)}
   ${summary}
   <Row><Cell ss:StyleID="sBody"><Data ss:Type="String">Exported at</Data></Cell><Cell ss:StyleID="sBody"><Data ss:Type="String">${nowIso}</Data></Cell></Row>
   <Row><Cell ss:StyleID="sBody"><Data ss:Type="String">Requested by</Data></Cell><Cell ss:StyleID="sBody"><Data ss:Type="String">${xmlEscape(requestedBy || '-')}</Data></Cell></Row>
   ${section('By score band')}${bandRows}
   ${section('By pipeline stage')}${stageRows}
   ${section('By source')}${sourceRows}
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <DisplayGridlines/>
  </WorksheetOptions>
 </Worksheet>
 <Worksheet ss:Name="Leads">
  <Table ss:DefaultRowHeight="16">${widths}${groupRow}${headerRow}${body}</Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <FreezePanes/><SplitHorizontal>2</SplitHorizontal><TopRowBottomPane>2</TopRowBottomPane>
   <SplitVertical>2</SplitVertical><LeftColumnRightPane>2</LeftColumnRightPane>
   <ActivePane>0</ActivePane>
   <Pane><xSplit>2</xSplit><ySplit>2</ySplit><TopRow>3</TopRow><LeftColumn>0</LeftColumn>
    <ActiveRow>3</ActiveRow><ActiveCol>2</ActiveCol></Pane>
   <PageSetup><x:Layout x:Orientation="Landscape"/><x:PageMargins x:Bottom="0.5" x:Left="0.4" x:Right="0.4" x:Top="0.5"/></PageSetup>
   <Print><ValidPrinterInfo/><PaperSizeIndex>9</PaperSizeIndex><HorizontalResolution>600</HorizontalResolution></Print>
   <Selected/>
  </WorksheetOptions>
  <AutoFilter x:Range="${filterRange}" xmlns="urn:schemas-microsoft-com:office:excel"/>
 </Worksheet>
</Workbook>`;
}

/** Plain-text CSV built from the same registry, for a "filtered CSV" download. */
export function buildLeadsCsv(rows: any[]): string {
  // Same cell writer as the workbook and the browser export: quoting, newline flattening
  // and the formula guard all live in leadsToCsv().
  return leadsToCsv(rows);
}
