"""
Export API endpoints for Beanthentic application.

Provides endpoints for exporting farmer data in various formats.
"""

from datetime import datetime

import io

from flask import redirect, send_file, url_for

from config.models import Farmer
from config.utils import is_authenticated


def register_export_routes(app):
    """Register export routes with the Flask app."""

    def _generate_csv_content(farmers):
        """Generate CSV content from farmer data."""
        output = io.StringIO()
        output.write("NO.,NAME OF FARMER,ADDRESS (BARANGAY),FA OFFICER / MEMBER,BIRTHDAY,RSBSA Registered (Yes/No),STATUS OF OWNERSHIP,Total Area Planted (HA.),LIBERICA BEARING,LIBERICA NON-BEARING,EXCELSA BEARING,EXCELSA NON-BEARING,ROBUSTA BEARING,ROBUSTA NON-BEARING,TOTAL BEARING,TOTAL NON-BEARING,TOTAL TREES,LIBERICA PRODUCTION,EXCELSA PRODUCTION,ROBUSTA PRODUCTION,NCFRS,REMARKS\n")

        for farmer in farmers:
            output.write(f"{farmer.no},{farmer.name},{farmer.address_barangay},{farmer.fa_officer_member},{farmer.birthday},{farmer.rsbsa_registered},{farmer.status_ownership},{farmer.total_area_planted_ha},{farmer.liberica_bearing},{farmer.liberica_non_bearing},{farmer.excelsa_bearing},{farmer.excelsa_non_bearing},{farmer.robusta_bearing},{farmer.robusta_non_bearing},{farmer.total_bearing},{farmer.total_non_bearing},{farmer.total_trees},{farmer.liberica_production},{farmer.excelsa_production},{farmer.robusta_production},{farmer.ncfrs},{farmer.remarks}\n")

        return output

    @app.route("/export/excel")
    def export_excel():
        """Export farmer data as CSV (Excel-compatible format)."""
        if not is_authenticated():
            return redirect(url_for("login"))

        farmers = Farmer.query.all()
        output = _generate_csv_content(farmers)

        # Create file in memory
        output.seek(0)
        mem = io.BytesIO()
        mem.write(output.getvalue().encode('utf-8'))
        mem.seek(0)

        return send_file(
            mem,
            as_attachment=True,
            download_name=f"farmer_data_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
            mimetype='text/csv'
        )

    @app.route("/export/pdf")
    def export_pdf():
        """Export farmer data as text report (PDF-style format)."""
        if not is_authenticated():
            return redirect(url_for("login"))

        farmers = Farmer.query.all()
        total_farmers = len(farmers)
        total_area = sum(f.total_area_planted_ha for f in farmers)
        total_trees = sum(f.total_trees for f in farmers)

        # Create text content
        pdf_content = f"""
    Farmer Data Report
    Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

    SUMMARY:
    - Total Farmers: {total_farmers}
    - Total Area Planted: {total_area:.2f} HA
    - Total Trees: {total_trees:,}

    DETAILED RECORDS:
    """

        for farmer in farmers[:20]:  # Limit to first 20 for readability
            pdf_content += f"""
    {farmer.no}. {farmer.name}
    Address: {farmer.address_barangay}
    FA Officer: {farmer.fa_officer_member}
    Area: {farmer.total_area_planted_ha} HA
    Trees: {farmer.total_trees:,}
    Production: Liberica={farmer.liberica_production}, Excelsa={farmer.excelsa_production}, Robusta={farmer.robusta_production}
    """

        if total_farmers > 20:
            pdf_content += f"\n... and {total_farmers - 20} more records"

        # Create file in memory
        mem = io.BytesIO()
        mem.write(pdf_content.encode('utf-8'))
        mem.seek(0)

        return send_file(
            mem,
            as_attachment=True,
            download_name=f"farmer_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt",
            mimetype='text/plain'
        )

    @app.route("/export/csv")
    def export_csv():
        """Export farmer data as CSV (duplicate of excel endpoint, kept for compatibility)."""
        if not is_authenticated():
            return redirect(url_for("login"))

        farmers = Farmer.query.all()
        output = _generate_csv_content(farmers)

        # Create file in memory
        output.seek(0)
        mem = io.BytesIO()
        mem.write(output.getvalue().encode('utf-8'))
        mem.seek(0)

        return send_file(
            mem,
            as_attachment=True,
            download_name=f"farmer_data_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
            mimetype='text/csv'
        )
