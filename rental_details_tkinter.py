import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import pandas as pd


MAP_OPENBY = {
    "kvasquez@nellyrac.com": "(11317) KARLA ELIZABETH VASQUEZ BLANCO",
    "KEVINFERNANDEZ@NELLYRAC.COM": "(11272) KEVIN EMMANUEL FERNANDEZ SIRI",
    "KVASQUEZ@NELLYRAC.COM": "(11317) KARLA ELIZABETH VASQUEZ BLANCO",
    "supervisor.santiago@nellyrac.com": "(06359) YDANIS JOEL BATISTA RODRIGUEZ",
    "angela.melo@nellyrac.com": "(11313) ANGELA MERCEDES MELO GONZALEZ",
    "servicioscorporativos@nellyrac.com": "(11264) LUIS JOEL DE LA CRUZ PEÑA",
    "Yamelterrero@nellyrac.com": "(11267) YAMEL IDALIA TERRERO SANTOS",
    "SERVICIOSCORPORATIVOS@NELLYRAC.COM": "(11264) LUIS JOEL DE LA CRUZ PEÑA",
    "p.lebron@nellyrac.com": "(11345) PAOLA ESTEFANNY LEBRON MARTINEZ",
    "e.silva@nellyrac.com": "(11336) ELIAS EDUARDO SILVA SALAS",
    "bryanlalondriz@nellyrac.com": "(08041) BRYAN JUSTICE LALONDRIZ ESPINAL",
    "alngelalmanzar@nellyrac.com": "(11320) ANGEL RAFAEL ALMANZAR GONZALEZ",
    "SilviaRosario@nellyrac.com": "(08440) SILVIA LEANNY ROSARIO MENDOZA",
    "r.rosario@nellyrac.com": "(11357) RONY ROSARIO",
    "d.almonte@nellyrac.com": "(11334) DANNERI LISSETTE ALMONTE ALMONTE",
    "d.rene@nellyrac.com": "(11269) DELOUIS RENE",
    "yoselydelacruz@nellyrac.com": "YOSELY DE LA CRUZ",
    "D.RENE@NELLYRAC.COM": "(11269) DELOUIS RENE",
    "YOSELYDELACRUZ@NELLYRAC.COM": "YOSELY DE LA CRUZ",
    "CDUVERGE@NELLYRAC.COM": "(11339) CARLOS DAVID DUVERGE",
    "aaasupportleasinghispaniola@rentcentric.com": "SUPPORT LEASING HISPANIOLA",
    "haroldacevedo@nellyrac.com": "(11315) HAROLD MANUEL ACEVEDO RONDÓN",
    "N.DIAZ@NELLYRAC.COM": "MARLIN DIAZ",
    "katherinebalbuena@nellyrac.com": "KATHERINE BALBUENA",
    "Yokennymorillo@nellyrac.com": "YOKENNY MORILLO",
    "miguelsosa@nellyrac.com": "(11344) MIGUEL SOSA",
    "r.garcia@nellyrac.com": "R GARCIA",
    "raquelsebastian@nellyrac.com": "RAQUEL SEBASTIAN",
    "P.lebron@nellyrac.com": "(11345) PAOLA ESTEFANNY LEBRON MARTINEZ",
    "fabelyortiz@nellyrac.com": "(11326) FABELY ORTIZ FATIOL",
    "e.peralta@nellyrac.com": "E PERALTA",
    "silviarosario@nellyrac.com": "(08440) SILVIA LEANNY ROSARIO MENDOZA",
    "gerencia.aila@nellyrac.com": "(11360) ANDRY QUIROZ",
    "Silviarosario@nellyrac.com": "(08440) SILVIA LEANNY ROSARIO",
    "Miguelsosa@nellyrac.com": "(11344) MIGUEL SOSA",
    "MIGUELSOSA@NELLYRAC.COM": "(11344) MIGUEL SOSA",
    "j.robinson@nellyrac.com": "(11355) JOSE ANEXIS ROBINSON CRUZ",
    "k.ciprian@nellyrac.com": "(11358) KEIDY CIPRIAN",
    "yokennymorillo@nellyrac.com": "YOKENNY MORILLO",
    "Fabelyortiz@nellyrac.com": "(11326) FABELY ORTIZ FATIOL",
    "a.quiroz@nellyrac.com": "(11360) ANDRY QUIROZ",
    "AAASupportLeasingHISPANIOLA@rentcentric.com": "SUPPORT LEASING HISPANIOLA",
    "j.luna@nellyrac.com": "JOAN LUNA",
    "analista@nellyrac.com": "MADELINE SERRANO",
    "auditoria@nellyrac.com": "FRANCISCO GIL",
    "Analista@nellyrac.com": "MADELINE SERRANO",
    "gerencia@nellyrac.com": "GLENNY OVALLES",
    "YOKENNYMORILLO@NELLYRAC.COM": "YOKENNY MORILLO",
    "mantenimiento@nellyrac.com": "ROBERTO POLANCO",
    "supervision.sdq@nellyrac.copm": "(11360) ANDRY QUIROZ",
    "coordinadordeflota@nellyrac.com": "CRISTIAN VALENZUELA",
    "brandarivera@nellyrac.com": "B RIVIERA",
    "KATHERINE BALBUENA": "KATHERINE BALBUENA",
    "(11326) FABELY ORTIZ FATIOL": "(11326) FABELY ORTIZ FATIOL",
    "(11355) JOSE ANEXIS ROBINSON CRUZ": "(11355) JOSE ANEXIS ROBINSON CRUZ",
    "DE LA CRUZ, JOSELY": "YOSELY DE LA CRUZ",
    "LALONDRIZ, BRYAN J": "(08041) BRYAN JUSTICE LALONDRIZ ESPINAL",
    "BALBUENA, KATHERINE": "KATHERINE BALBUENA",
    "ROBINSON, JOSE A": "(11355) JOSE ANEXIS ROBINSON CRUZ",
    "ORTIZ, FABELY": "(11326) FABELY ORTIZ FATIOL",
    "DIAZ, MARLIN I": "MARLIN DIAZ",
}

EXPECTED_HEADER_INDICATORS = [
    "RA#",
    "Customer ID",
    "Opened by",
    "Pickup Date",
    "Return Date",
]


def find_header_row(dataframe: pd.DataFrame) -> int:
    for index, row in dataframe.iterrows():
        row_values = row.astype(str).str.strip().str.lower()
        if any(
            indicator.lower() in cell_value
            for indicator in EXPECTED_HEADER_INDICATORS
            for cell_value in row_values
        ):
            return index
    raise ValueError(
        "No se pudo encontrar una fila de encabezados con indicadores como "
        "'RA#', 'Customer ID', 'Opened by', 'Pickup Date' o 'Return Date'."
    )


def resolve_opened_by_column(columns: pd.Index) -> str:
    for column in columns:
        if column.lower() == "opened by":
            return column
    for column in columns:
        if "opened by" in column.lower():
            return column
    raise KeyError(
        "No se encontró una columna llamada 'Opened by'. "
        f"Columnas disponibles: {list(columns)}"
    )


def clean_rental_details(input_path: Path, output_path: Path) -> int:
    df_raw = pd.read_excel(input_path, header=None)
    header_row_index = find_header_row(df_raw)

    df = df_raw.iloc[header_row_index:].copy()
    df.columns = df.iloc[0]
    df = df[1:].reset_index(drop=True)
    df.columns = df.columns.astype(str).str.strip()

    opened_by_column = resolve_opened_by_column(df.columns)
    normalized_map = {key.strip().upper(): value for key, value in MAP_OPENBY.items()}

    df["Openedby_Normalizado"] = (
        df[opened_by_column]
        .astype(str)
        .str.strip()
        .str.upper()
        .map(normalized_map)
        .fillna(df[opened_by_column])
    )

    df["Pickup Date"] = pd.to_datetime(df["Pickup Date"], errors="coerce").dt.strftime(
        "%Y-%m-%d"
    )
    df["Return Date"] = pd.to_datetime(df["Return Date"], errors="coerce").dt.strftime(
        "%Y-%m-%d"
    )
    df.to_excel(output_path, index=False)
    return len(df.index)


class RentalDetailsApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Rental Details Cleaner")
        self.root.geometry("760x260")
        self.root.minsize(700, 240)

        self.input_path = tk.StringVar()
        self.output_path = tk.StringVar()
        self.status_text = tk.StringVar(value="Selecciona un archivo Excel para comenzar.")

        self.build_ui()

    def build_ui(self) -> None:
        container = ttk.Frame(self.root, padding=18)
        container.pack(fill="both", expand=True)
        container.columnconfigure(1, weight=1)

        title = ttk.Label(
            container,
            text="Procesar Rental Details Report",
            font=("Segoe UI", 15, "bold"),
        )
        title.grid(row=0, column=0, columnspan=3, sticky="w", pady=(0, 14))

        ttk.Label(container, text="Archivo origen:").grid(
            row=1, column=0, sticky="w", pady=6
        )
        ttk.Entry(container, textvariable=self.input_path).grid(
            row=1, column=1, sticky="ew", padx=8, pady=6
        )
        ttk.Button(container, text="Buscar", command=self.choose_input_file).grid(
            row=1, column=2, sticky="ew", pady=6
        )

        ttk.Label(container, text="Archivo salida:").grid(
            row=2, column=0, sticky="w", pady=6
        )
        ttk.Entry(container, textvariable=self.output_path).grid(
            row=2, column=1, sticky="ew", padx=8, pady=6
        )
        ttk.Button(container, text="Guardar como", command=self.choose_output_file).grid(
            row=2, column=2, sticky="ew", pady=6
        )

        ttk.Button(container, text="Procesar archivo", command=self.process_file).grid(
            row=3, column=0, columnspan=3, sticky="ew", pady=(18, 10)
        )

        ttk.Label(
            container,
            textvariable=self.status_text,
            wraplength=700,
            justify="left",
        ).grid(row=4, column=0, columnspan=3, sticky="w", pady=(8, 0))

    def choose_input_file(self) -> None:
        selected_file = filedialog.askopenfilename(
            title="Selecciona el Rental Details Report",
            filetypes=[("Excel files", "*.xlsx *.xls"), ("All files", "*.*")],
        )
        if not selected_file:
            return

        input_path = Path(selected_file)
        self.input_path.set(str(input_path))
        suggested_output = input_path.with_name(f"{input_path.stem}_Clean.xlsx")
        self.output_path.set(str(suggested_output))
        self.status_text.set("Archivo seleccionado. Ya puedes procesarlo.")

    def choose_output_file(self) -> None:
        selected_file = filedialog.asksaveasfilename(
            title="Guardar archivo limpio",
            defaultextension=".xlsx",
            filetypes=[("Excel files", "*.xlsx")],
        )
        if selected_file:
            self.output_path.set(selected_file)

    def process_file(self) -> None:
        input_file = self.input_path.get().strip()
        output_file = self.output_path.get().strip()

        if not input_file:
            messagebox.showwarning("Falta archivo", "Selecciona primero el archivo Excel.")
            return
        if not output_file:
            messagebox.showwarning(
                "Falta salida", "Indica dónde quieres guardar el archivo limpio."
            )
            return

        try:
            row_count = clean_rental_details(Path(input_file), Path(output_file))
        except Exception as error:
            self.status_text.set(f"Error: {error}")
            messagebox.showerror("No se pudo procesar", str(error))
            return

        success_message = (
            f"Proceso completado. Se guardaron {row_count} filas en:\n{output_file}"
        )
        self.status_text.set(success_message)
        messagebox.showinfo("Listo", success_message)


def main() -> None:
    root = tk.Tk()
    style = ttk.Style()
    if "vista" in style.theme_names():
        style.theme_use("vista")
    app = RentalDetailsApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
